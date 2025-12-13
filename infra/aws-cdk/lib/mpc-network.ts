import * as cdk from "aws-cdk-lib";
import * as constructs from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as iam from "aws-cdk-lib/aws-iam";

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
  /** Docker image URI (default: Docker Hub image matching GCP production) */
  dockerImageUri?: string;
  /** CPU units per node (default: 512 = 0.5 vCPU) */
  cpu?: number;
  /** Memory per node in MB (default: 1024 = 1 GB) */
  memory?: number;
  /** Cloud Map namespace name (default: "mpc.local") */
  namespaceName?: string;
  /** Instance type for EC2 instances (default: t3.medium) */
  instanceType?: ec2.InstanceType;
  /** EBS volume size in GB (default: 100) */
  ebsVolumeSize?: number;
  /** Auto-generate test keys for sandbox/development (default: true for localnet, false otherwise) */
  autoGenerateKeys?: boolean;
}

export class MpcNetwork extends constructs.Construct {
  public readonly namespace: servicediscovery.INamespace;
  public readonly instances: ec2.Instance[];
  public readonly secrets: secretsmanager.ISecret[];
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
      instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      ebsVolumeSize = 100,
      namespaceName = "mpc.local",
      autoGenerateKeys = nearNetworkId === "localnet" || nearNetworkId === "mpc-localnet",
    } = props;

    // Default to Docker Hub image matching GCP production setup
    // Users can override via dockerImageUri prop or context/env var
    const defaultImageUri = nearNetworkId === "testnet" || nearNetworkId === "mainnet"
      ? "docker.io/nearone/mpc-node-gcp:testnet-release"
      : "docker.io/nearone/mpc-node-gcp:testnet-release"; // Default to testnet-release for now
    const imageUri = dockerImageUri || defaultImageUri;

    // 1. Create Cloud Map Namespace for service discovery (must be created before cluster)
    // Use a unique namespace name to avoid conflicts with existing hosted zones
    const uniqueNamespaceName = `mpc-${cdk.Stack.of(this).stackName.toLowerCase()}.local`;
    this.namespace = new servicediscovery.PrivateDnsNamespace(this, "MpcNamespace", {
      name: uniqueNamespaceName,
      vpc,
      description: "MPC node service discovery",
    });

    // 2. Image URI is now determined above (defaults to Docker Hub, can be overridden)

    // 3. Create Security Group for MPC nodes
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

    // 4. Create Secrets Manager secrets for each node
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
      // Secrets are created with placeholder values in plain text format (not JSON)
      // The deployment script will replace these with actual values
      const nodeSecrets: { [key: string]: secretsmanager.ISecret } = {};
      
      for (const keyName of secretKeys) {
        // Create secret with a simple placeholder string (NOT JSON wrapped)
        // This prevents ECS from failing when trying to retrieve secrets
        const secret = new secretsmanager.Secret(this, `Node${i}${keyName}Secret`, {
          secretName: `mpc-node-${i}-${keyName.toLowerCase()}`,
          description: `MPC node ${i} ${keyName}`,
          secretStringValue: cdk.SecretValue.unsafePlainText("PLACEHOLDER_REPLACE_WITH_REAL_KEY"),
        });
        nodeSecrets[keyName] = secret;
        this.secrets.push(secret);
      }
      
      // Store reference to node secrets for use in task definition
      this.nodeSecrets.set(i, nodeSecrets);
    }

    // 5. Create IAM Role for EC2 instances
    const instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Role for MPC node EC2 instances",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"), // For SSM access
      ],
    });

    // Grant instance role access to all secrets
    for (const secret of this.secrets) {
      secret.grantRead(instanceRole);
    }

    // Grant instance role permission to register with Cloud Map
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "servicediscovery:RegisterInstance",
          "servicediscovery:DeregisterInstance",
          "servicediscovery:GetInstance",
        ],
        resources: [this.namespace.namespaceArn],
      })
    );

    // Create instance profile
    const instanceProfile = new iam.CfnInstanceProfile(this, "InstanceProfile", {
      roles: [instanceRole.roleName],
    });

    // 6. Create EC2 Instances (one per node)
    this.instances = [];
    for (let i = 0; i < nodeConfigs.length; i++) {
      const nodeConfig = nodeConfigs[i];
      const nodeSecretsMap = this.nodeSecrets.get(i)!;

      // Create EBS volume for this node
      const ebsVolume = new ec2.Volume(this, `Node${i}Volume`, {
        availabilityZone: vpc.availabilityZones[0], // Use first AZ
        size: cdk.Size.gibibytes(ebsVolumeSize),
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        encrypted: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN, // Retain data across stack deletions
      });

      // Generate UserData script
      const userData = this.generateUserDataScript({
        nodeIndex: i,
        nodeConfig,
        imageUri,
        mpcContractId,
        nearNetworkId,
        nearRpcUrl,
        nearBootNodes,
        nodeSecretsMap,
        namespaceId: this.namespace.namespaceId,
      });

      // Create EC2 instance
      const instance = new ec2.Instance(this, `Node${i}Instance`, {
        vpc,
        instanceType,
        machineImage: ec2.MachineImage.latestAmazonLinux2023({
          cpuType: ec2.AmazonLinuxCpuType.X86_64,
        }),
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: mpcSecurityGroup,
        role: instanceRole,
        userData: ec2.UserData.custom(userData),
        blockDevices: [
          {
            deviceName: "/dev/xvda",
            volume: ec2.BlockDeviceVolume.ebs(20, {
              volumeType: ec2.EbsDeviceVolumeType.GP3,
              deleteOnTermination: true,
            }),
          },
        ],
      });

      // Attach EBS volume to instance
      instance.node.addDependency(ebsVolume);
      new ec2.CfnVolumeAttachment(this, `Node${i}VolumeAttachment`, {
        instanceId: instance.instanceId,
        volumeId: ebsVolume.volumeId,
        device: "/dev/sdf", // Standard EBS device name
      });

      // Register instance with Cloud Map for service discovery
      const service = new servicediscovery.Service(this, `Node${i}Service`, {
        namespace: this.namespace,
        name: `node-${i}`,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(60),
      });

      // Register the instance IP with Cloud Map
      // Note: This requires the instance to be running, so we use a custom resource
      // or rely on UserData script to register via AWS CLI
      // For now, we'll add the registration to UserData script

      this.instances.push(instance);
    }

    // Stack outputs
    new cdk.CfnOutput(this, "MpcNamespaceId", {
      value: this.namespace.namespaceId,
      exportName: "MpcNamespaceId",
    });

    for (let i = 0; i < this.instances.length; i++) {
      const nodeConfig = nodeConfigs[i];
      
      new cdk.CfnOutput(this, `Node${i}InstanceId`, {
        value: this.instances[i].instanceId,
        exportName: `MpcNode${i}InstanceId`,
        description: `EC2 Instance ID for MPC Node ${i}`,
      });

      new cdk.CfnOutput(this, `Node${i}PrivateIp`, {
        value: this.instances[i].instancePrivateIp,
        exportName: `MpcNode${i}PrivateIp`,
        description: `Private IP address for MPC Node ${i}`,
      });

      new cdk.CfnOutput(this, `Node${i}AccountId`, {
        value: nodeConfig.accountId,
        exportName: `MpcNode${i}AccountId`,
        description: `NEAR account ID for MPC Node ${i}`,
      });
    }
  }

  /**
   * Generates UserData script for EC2 instance startup
   * Similar to GCP's cloud-config, this script:
   * 1. Formats and mounts the EBS volume
   * 2. Installs Docker
   * 3. Pulls the Docker image from Docker Hub (or configured registry)
   * 4. Fetches secrets from Secrets Manager
   * 5. Runs the MPC node container
   */
  private generateUserDataScript(params: {
    nodeIndex: number;
    nodeConfig: MpcNodeConfig;
    imageUri: string;
    mpcContractId: string;
    nearNetworkId: string;
    nearRpcUrl: string;
    nearBootNodes: string;
    nodeSecretsMap: { [key: string]: secretsmanager.ISecret };
    namespaceId: string;
  }): string {
    const {
      nodeIndex,
      nodeConfig,
      imageUri,
      mpcContractId,
      nearNetworkId,
      nearRpcUrl,
      nearBootNodes,
      nodeSecretsMap,
      namespaceId,
    } = params;

    const dataDir = "/data";
    const region = cdk.Stack.of(this).region;

    // Get secret ARNs for AWS CLI retrieval
    const accountSkSecretArn = nodeSecretsMap.MPC_ACCOUNT_SK.secretArn;
    const p2pKeySecretArn = nodeSecretsMap.MPC_P2P_PRIVATE_KEY.secretArn;
    const secretStoreKeySecretArn = nodeSecretsMap.MPC_SECRET_STORE_KEY.secretArn;

    return `#!/bin/bash
set -exo pipefail

# Install Docker
yum update -y
yum install -y docker
systemctl start docker
systemctl enable docker
usermod -a -G docker ec2-user

# Install AWS CLI v2 if not present
if ! command -v aws &> /dev/null; then
  curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
  yum install -y unzip
  unzip awscliv2.zip
  ./aws/install
fi

# Wait for EBS volume to be attached
# EBS volumes attached as /dev/sdf appear as /dev/nvme1n1 on newer instance types
# Try both device names
DEVICE=""
for dev in /dev/nvme1n1 /dev/sdf /dev/xvdf; do
  if [ -e $dev ]; then
    DEVICE=$dev
    break
  fi
done

if [ -z "$DEVICE" ]; then
  echo "Waiting for EBS volume to attach..."
  sleep 5
  # Try again after a short wait
  for dev in /dev/nvme1n1 /dev/sdf /dev/xvdf; do
    if [ -e $dev ]; then
      DEVICE=$dev
      break
    fi
  done
fi

if [ -z "$DEVICE" ]; then
  echo "ERROR: Could not find attached EBS volume"
  exit 1
fi

echo "Found EBS volume at $DEVICE"

# Format and mount the EBS volume
if ! blkid $DEVICE | grep -q ext4; then
  echo "Formatting $DEVICE as ext4..."
  mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard $DEVICE
fi

mkdir -p ${dataDir}
mount -o discard,defaults $DEVICE ${dataDir}

# Add to fstab for persistence
UUID=$(blkid -s UUID -o value $DEVICE)
if ! grep -q "$UUID" /etc/fstab; then
  echo "UUID=$UUID ${dataDir} ext4 discard,defaults,nofail 0 2" >> /etc/fstab
fi

# Fetch secrets from Secrets Manager
export MPC_ACCOUNT_SK=$(aws secretsmanager get-secret-value --secret-id ${accountSkSecretArn} --region ${region} --query SecretString --output text)
export MPC_P2P_PRIVATE_KEY=$(aws secretsmanager get-secret-value --secret-id ${p2pKeySecretArn} --region ${region} --query SecretString --output text)
export MPC_SECRET_STORE_KEY=$(aws secretsmanager get-secret-value --secret-id ${secretStoreKeySecretArn} --region ${region} --query SecretString --output text)

# Pull the Docker image (from Docker Hub or configured registry)
docker pull ${imageUri}

# Stop and remove any existing container
docker stop mpc-node || true
docker rm mpc-node || true

# Run the MPC node container
docker run -d --name mpc-node --restart=always --net=host \\
  -v ${dataDir}:/data \\
  -e MPC_HOME_DIR="/data" \\
  -e MPC_ACCOUNT_ID="${nodeConfig.accountId}" \\
  -e MPC_LOCAL_ADDRESS="${nodeConfig.localAddress}" \\
  -e MPC_RESPONDER_ID="${nodeConfig.responderId || nodeConfig.accountId}" \\
  -e MPC_CONTRACT_ID="${mpcContractId}" \\
  -e MPC_ENV="${nearNetworkId}" \\
  -e NEAR_RPC_URL="${nearRpcUrl}" \\
  -e NEAR_BOOT_NODES="${nearBootNodes}" \\
  -e MPC_ACCOUNT_SK="$MPC_ACCOUNT_SK" \\
  -e MPC_P2P_PRIVATE_KEY="$MPC_P2P_PRIVATE_KEY" \\
  -e MPC_SECRET_STORE_KEY="$MPC_SECRET_STORE_KEY" \\
  -e RUST_BACKTRACE="full" \\
  -e RUST_LOG="mpc=debug,info" \\
  ${imageUri}

# Register with Cloud Map (optional - for service discovery)
INSTANCE_IP=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4)
NAMESPACE_ID="${namespaceId}"
SERVICE_ID=$(aws servicediscovery list-services --filters Name=NAMESPACE_ID,Values=$NAMESPACE_ID --query "Services[?Name=='node-${nodeIndex}'].Id" --output text --region ${region})

if [ ! -z "$SERVICE_ID" ]; then
  aws servicediscovery register-instance \\
    --service-id $SERVICE_ID \\
    --instance-id "node-${nodeIndex}" \\
    --attributes A="$INSTANCE_IP" \\
    --region ${region} || true
fi

echo "MPC node ${nodeIndex} startup complete"
`;
  }
}

