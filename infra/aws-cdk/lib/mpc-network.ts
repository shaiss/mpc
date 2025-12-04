import * as cdk from "aws-cdk-lib";
import * as constructs from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as s3_assets from "aws-cdk-lib/aws-s3-assets";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as custom_resources from "aws-cdk-lib/custom-resources";
import * as path from "path";

export interface MpcNodeConfig {
  /** NEAR account ID for this MPC node (e.g., "mpc-node-0.localnet") */
  accountId: string;
  /** Local address/hostname for this node (used in MPC_LOCAL_ADDRESS) */
  localAddress: string;
  /** Optional responder ID (defaults to accountId if not provided) */
  responderId?: string;
}

export interface MpcNetworkProps {
  /** VPC where MPC nodes will run */
  vpc: ec2.IVpc;
  /** NEAR RPC URL (e.g., "http://10.0.1.100:3030") */
  nearRpcUrl: string;
  /** NEAR network ID (e.g., "localnet", "testnet", "mainnet") */
  nearNetworkId: string;
  /** NEAR boot nodes (comma-separated list) */
  nearBootNodes: string;
  /** MPC contract ID (e.g., "v1.signer.node0" for localnet) */
  mpcContractId: string;
  /** Configuration for each MPC node */
  nodeConfigs: MpcNodeConfig[];
  /** (Optional) Fully-qualified Docker image URI to use instead of building */
  dockerImageUri?: string;
  /** Image tag to use when building via CodeBuild (default: "latest") */
  imageTag?: string;
  /** CPU units per node (default: 512 = 0.5 vCPU) */
  cpu?: number;
  /** Memory per node in MB (default: 1024 = 1 GB) */
  memory?: number;
  /** Cloud Map namespace name (default: "mpc.local") */
  namespaceName?: string;
  /** EFS performance mode (default: GENERAL_PURPOSE) */
  efsPerformanceMode?: efs.PerformanceMode;
  /** EFS throughput mode (default: BURSTING) */
  efsThroughputMode?: efs.ThroughputMode;
}

export class MpcNetwork extends constructs.Construct {
  public readonly cluster: ecs.ICluster;
  public readonly fileSystem: efs.FileSystem;
  public readonly namespace: servicediscovery.INamespace;
  public readonly services: ecs.FargateService[];
  public readonly secrets: secretsmanager.ISecret[];
  public readonly ecrRepository?: ecr.Repository;
  private readonly nodeSecrets: Map<number, { [key: string]: secretsmanager.ISecret }> = new Map();

  constructor(scope: constructs.Construct, id: string, props: MpcNetworkProps) {
    super(scope, id);

    const {
      vpc,
      nearRpcUrl,
      nearNetworkId,
      nearBootNodes,
      mpcContractId,
      nodeConfigs,
      dockerImageUri,
      imageTag = "latest",
      cpu = 512, // 0.5 vCPU
      memory = 1024, // 1 GB
      namespaceName = "mpc.local",
      efsPerformanceMode = efs.PerformanceMode.GENERAL_PURPOSE,
      efsThroughputMode = efs.ThroughputMode.BURSTING,
    } = props;

    // 1. Create Cloud Map Namespace for service discovery (must be created before cluster)
    // Use a unique namespace name to avoid conflicts with existing hosted zones
    const uniqueNamespaceName = `mpc-${cdk.Stack.of(this).stackName.toLowerCase()}.local`;
    this.namespace = new servicediscovery.PrivateDnsNamespace(this, "MpcNamespace", {
      name: uniqueNamespaceName,
      vpc,
      description: "MPC node service discovery",
    });

    // 2. Build and publish container image (default) or use provided image URI
    const repoRoot = path.join(__dirname, "../../../");
    let containerImage: ecs.ContainerImage;
    let imageBuildDependency: cdk.CustomResource | undefined;

    if (dockerImageUri) {
      containerImage = ecs.ContainerImage.fromRegistry(dockerImageUri);
    } else {
    this.ecrRepository = new ecr.Repository(this, "MpcNodeRepository", {
      repositoryName: "mpc-node",
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          description: "Keep last 10 images",
          maxImageCount: 10,
        },
      ],
    });

      const dockerSourceAsset = new s3_assets.Asset(this, "MpcDockerSource", {
        path: repoRoot,
        exclude: [
          "infra/aws-cdk/cdk.out",
          "infra/aws-cdk/node_modules",
          "infra/aws-cdk/.jsii",
          "node_modules",
          "target",
          ".git",
          ".github",
        ],
        followSymlinks: cdk.SymlinkFollowMode.NEVER,
      });

      const imageUri = `${this.ecrRepository.repositoryUri}:${imageTag}`;

      const buildProject = new codebuild.Project(this, "MpcImageBuilder", {
        projectName: `${cdk.Stack.of(this).stackName}-mpc-image`,
        description: "Builds the MPC node image and pushes it to ECR",
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: codebuild.ComputeType.LARGE,
          privileged: true,
        },
        timeout: cdk.Duration.hours(1),
        source: codebuild.Source.s3({
          bucket: dockerSourceAsset.bucket,
          path: dockerSourceAsset.s3ObjectKey,
        }),
        buildSpec: codebuild.BuildSpec.fromObject({
          version: "0.2",
          env: {
            variables: {
              IMAGE_URI: imageUri,
            },
          },
          phases: {
            pre_build: {
              commands: [
                "set -e",
                "AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)",
                "aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com",
              ],
            },
            build: {
              commands: [
                "echo Building MPC node image",
                "cd $CODEBUILD_SRC_DIR",
                "docker build -f Dockerfile.local -t $IMAGE_URI .",
                "docker push $IMAGE_URI",
              ],
            },
          },
        }),
      });

      dockerSourceAsset.grantRead(buildProject);
      this.ecrRepository.grantPullPush(buildProject);

      const startBuildFn = new lambda.Function(this, "MpcImageBuildStarter", {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "index.handler",
        timeout: cdk.Duration.minutes(5),
        code: lambda.Code.fromInline(`
const AWS = require("aws-sdk");
const codebuild = new AWS.CodeBuild();
exports.handler = async (event) => {
  console.log("onEvent", JSON.stringify(event));
  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: event.PhysicalResourceId || event.RequestId };
  }
  const projectName = event.ResourceProperties.ProjectName;
  const start = await codebuild.startBuild({ projectName }).promise();
  return {
    PhysicalResourceId: start.build.id,
    Data: { BuildId: start.build.id },
  };
};
        `),
      });

      const checkBuildFn = new lambda.Function(this, "MpcImageBuildMonitor", {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "index.handler",
        timeout: cdk.Duration.minutes(15),
        code: lambda.Code.fromInline(`
const AWS = require("aws-sdk");
const codebuild = new AWS.CodeBuild();
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"]);
exports.handler = async (event) => {
  console.log("isComplete", JSON.stringify(event));
  if (event.RequestType === "Delete") {
    return { IsComplete: true };
  }
  const buildId = (event.Data && event.Data.BuildId) || event.PhysicalResourceId;
  const resp = await codebuild.batchGetBuilds({ ids: [buildId] }).promise();
  const build = resp.builds && resp.builds[0];
  if (!build) {
    throw new Error("Unable to find build " + buildId);
  }
  if (!TERMINAL.has(build.buildStatus)) {
    return { IsComplete: false };
  }
  if (build.buildStatus !== "SUCCEEDED") {
    throw new Error("CodeBuild project failed with status " + build.buildStatus);
  }
  return { IsComplete: true };
};
        `),
      });

      startBuildFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["codebuild:StartBuild"],
          resources: [buildProject.projectArn],
        })
      );
      checkBuildFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["codebuild:BatchGetBuilds"],
          resources: [buildProject.projectArn],
        })
      );

      const buildProvider = new custom_resources.Provider(this, "MpcImageBuildProvider", {
        onEventHandler: startBuildFn,
        isCompleteHandler: checkBuildFn,
        queryInterval: cdk.Duration.seconds(30),
        totalTimeout: cdk.Duration.hours(2),
      });

      imageBuildDependency = new cdk.CustomResource(this, "MpcImageBuild", {
        serviceToken: buildProvider.serviceToken,
        properties: {
          ProjectName: buildProject.projectName,
          AssetHash: dockerSourceAsset.assetHash,
          ImageTag: imageTag,
        },
      });

      containerImage = ecs.ContainerImage.fromEcrRepository(this.ecrRepository, imageTag);
    }

    // 3. Create ECS Cluster
    this.cluster = new ecs.Cluster(this, "MpcCluster", {
      vpc,
      clusterName: "mpc-nodes",
      containerInsights: true,
    });

    // 4. Create Security Group for MPC nodes (before EFS, so EFS can reference it)
    const mpcSecurityGroup = new ec2.SecurityGroup(this, "MpcSecurityGroup", {
      vpc,
      description: "Security group for MPC nodes",
      allowAllOutbound: true,
    });

    // Allow MPC nodes to communicate with each other
    mpcSecurityGroup.addIngressRule(
      mpcSecurityGroup,
      ec2.Port.tcp(3030), // NEAR RPC
      "Allow NEAR RPC between MPC nodes"
    );
    mpcSecurityGroup.addIngressRule(
      mpcSecurityGroup,
      ec2.Port.tcp(8080), // MPC Web UI
      "Allow MPC Web UI access"
    );
    mpcSecurityGroup.addIngressRule(
      mpcSecurityGroup,
      ec2.Port.tcp(24567), // NEAR P2P
      "Allow NEAR P2P between MPC nodes"
    );

    // 5. Create EFS File System with security group that allows NFS from MPC nodes
    this.fileSystem = new efs.FileSystem(this, "MpcFileSystem", {
      vpc,
      performanceMode: efsPerformanceMode,
      throughputMode: efsThroughputMode,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Retain data across stack deletions
      encrypted: true,
      // Specify security group to allow NFS access from MPC nodes
      securityGroup: new ec2.SecurityGroup(this, "EfsSecurityGroup", {
        vpc,
        description: "Security group for MPC EFS",
        allowAllOutbound: false,
      }),
    });

    // Allow NFS traffic from MPC nodes to EFS
    this.fileSystem.connections.allowFrom(
      mpcSecurityGroup,
      ec2.Port.tcp(2049),
      "Allow NFS from MPC nodes"
    );

    // 6. Create EFS Access Points (one per node)
    const accessPoints: efs.AccessPoint[] = [];
    for (let i = 0; i < nodeConfigs.length; i++) {
      const accessPoint = new efs.AccessPoint(this, `Node${i}AccessPoint`, {
        fileSystem: this.fileSystem,
        path: `/node-${i}`,
        createAcl: {
          ownerUid: "1000",
          ownerGid: "1000",
          permissions: "755",
        },
        posixUser: {
          uid: "1000",
          gid: "1000",
        },
      });
      accessPoints.push(accessPoint);
    }

    // 7. Create Secrets Manager secrets for each node
    // We create individual secrets for required keys
    // Required by start.sh: MPC_ACCOUNT_SK, MPC_P2P_PRIVATE_KEY, MPC_SECRET_STORE_KEY
    // Optional: MPC_CIPHER_PK, MPC_SIGN_SK (not used by start.sh but may be needed by MPC node)
    this.secrets = [];
    const secretKeys = [
      "MPC_ACCOUNT_SK",
      "MPC_P2P_PRIVATE_KEY", 
      "MPC_SECRET_STORE_KEY",
    ];

    for (let i = 0; i < nodeConfigs.length; i++) {
      const nodeConfig = nodeConfigs[i];
      
      // Create individual secrets for each key
      // IMPORTANT: These secrets must be populated with real values after deployment!
      // For localnet: Use test keys generated via NEAR CLI or MPC node initialization
      // For testnet/mainnet: Use production keys with proper security
      const nodeSecrets: { [key: string]: secretsmanager.ISecret } = {};
      
      for (const keyName of secretKeys) {
        // For SECRET_STORE_KEY in localnet, we can use a simple 32-character string
        // For production, this should be a secure random value
        const isSecretStoreKey = keyName === "MPC_SECRET_STORE_KEY";
        
        const secret = new secretsmanager.Secret(this, `Node${i}${keyName}Secret`, {
          secretName: `mpc-node-${i}-${keyName.toLowerCase()}`,
          description: `MPC node ${i} ${keyName}`,
          generateSecretString: isSecretStoreKey ? {
            // For SECRET_STORE_KEY: Generate a random 32-character string (any value works for localnet)
            secretStringTemplate: JSON.stringify({}),
            generateStringKey: "key",
            passwordLength: 32,
            excludeCharacters: "\"'\\/@",
          } : {
            // For other keys: Create placeholder that MUST be replaced before node can start
            secretStringTemplate: JSON.stringify({ key: "REPLACE_WITH_REAL_KEY_BEFORE_DEPLOYMENT" }),
            generateStringKey: "dummy",
          },
        });
        nodeSecrets[keyName] = secret;
        this.secrets.push(secret);
      }
      
      // Store reference to node secrets for use in task definition
      this.nodeSecrets.set(i, nodeSecrets);
    }

    // 8. Create Task Execution Role (for ECS to pull images and access secrets)
    const taskExecutionRole = new iam.Role(this, "TaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });

    // Grant task execution role access to all secrets
    for (const secret of this.secrets) {
      secret.grantRead(taskExecutionRole);
    }

    // Grant task execution role permission to pull from ECR
    // this.ecrRepository.grantPull(taskExecutionRole); // handled by fromAsset

    // 9. Create Task Role (for the container itself)
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Role for MPC node containers",
    });

    // Grant task role access to EFS (required when iam: "ENABLED" in EFS volume config)
    // The task role (not execution role) needs these permissions because the container
    // itself performs the EFS mount operation when IAM authorization is enabled
    this.fileSystem.grant(taskRole, "elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite");

    // 10. Create Fargate Services (one per node)
    this.services = [];
    for (let i = 0; i < nodeConfigs.length; i++) {
      const nodeConfig = nodeConfigs[i];
      const accessPoint = accessPoints[i];
      const nodeSecretsMap = this.nodeSecrets.get(i)!;

      // Task Definition
      const taskDefinition = new ecs.FargateTaskDefinition(this, `Node${i}TaskDefinition`, {
        cpu,
        memoryLimitMiB: memory,
        executionRole: taskExecutionRole,
        taskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      const container = taskDefinition.addContainer(`Node${i}Container`, {
        image: containerImage,
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: `mpc-node-${i}`,
          logRetention: logs.RetentionDays.ONE_WEEK,
        }),
        environment: {
          MPC_ACCOUNT_ID: nodeConfig.accountId,
          MPC_LOCAL_ADDRESS: nodeConfig.localAddress,
          MPC_RESPONDER_ID: nodeConfig.responderId || nodeConfig.accountId,
          MPC_CONTRACT_ID: mpcContractId,
          // IMPORTANT: MPC_ENV must be the chain-id (e.g., "mpc-localnet" for localnet, "testnet", "mainnet")
          MPC_ENV: nearNetworkId,
          MPC_HOME_DIR: "/data",
          NEAR_RPC_URL: nearRpcUrl,
          NEAR_BOOT_NODES: nearBootNodes,
          RUST_BACKTRACE: "full",
          RUST_LOG: "mpc=debug,info",
        },
        secrets: {
          // Inject secrets as environment variables
          // The MPC node start.sh script uses these directly:
          // - MPC_ACCOUNT_SK: NEAR account secret key (lines 59, 162-170 in start.sh)
          // - MPC_P2P_PRIVATE_KEY: libp2p private key (lines 58, 151-159 in start.sh)
          // - MPC_SECRET_STORE_KEY: Encryption key for local storage (lines 211-217 in start.sh)
          MPC_ACCOUNT_SK: ecs.Secret.fromSecretsManager(nodeSecretsMap.MPC_ACCOUNT_SK, "key"),
          MPC_P2P_PRIVATE_KEY: ecs.Secret.fromSecretsManager(nodeSecretsMap.MPC_P2P_PRIVATE_KEY, "key"),
          MPC_SECRET_STORE_KEY: ecs.Secret.fromSecretsManager(nodeSecretsMap.MPC_SECRET_STORE_KEY, "key"),
        },
      });

      // Mount EFS Access Point
      taskDefinition.addVolume({
        name: "mpc-data",
        efsVolumeConfiguration: {
          fileSystemId: this.fileSystem.fileSystemId,
          authorizationConfig: {
            accessPointId: accessPoint.accessPointId,
            iam: "ENABLED",
          },
          transitEncryption: "ENABLED",
        },
      });

      container.addMountPoints({
        sourceVolume: "mpc-data",
        containerPath: "/data",
        readOnly: false,
      });

      // Service Discovery
      const service = new ecs.FargateService(this, `Node${i}Service`, {
        cluster: this.cluster,
        taskDefinition,
        desiredCount: 1,
        securityGroups: [mpcSecurityGroup],
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        serviceName: `node-${i}`,
      });

      // Register service with Cloud Map
      service.enableCloudMap({
        name: `node-${i}`,
        cloudMapNamespace: this.namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(60),
      });

      this.services.push(service);

      if (imageBuildDependency) {
        service.node.addDependency(imageBuildDependency);
      }
    }

    // Stack outputs
    if (this.ecrRepository) {
    new cdk.CfnOutput(this, "MpcEcrRepositoryUri", {
      value: this.ecrRepository.repositoryUri,
      description: "ECR repository URI for MPC node images",
      exportName: "MpcEcrRepositoryUri",
    });
    }

    new cdk.CfnOutput(this, "MpcClusterName", {
      value: this.cluster.clusterName,
      exportName: "MpcClusterName",
    });

    new cdk.CfnOutput(this, "MpcFileSystemId", {
      value: this.fileSystem.fileSystemId,
      exportName: "MpcFileSystemId",
    });

    new cdk.CfnOutput(this, "MpcNamespaceId", {
      value: this.namespace.namespaceId,
      exportName: "MpcNamespaceId",
    });

    for (let i = 0; i < this.services.length; i++) {
      new cdk.CfnOutput(this, `Node${i}ServiceName`, {
        value: this.services[i].serviceName,
        exportName: `MpcNode${i}ServiceName`,
      });
    }
  }
}

