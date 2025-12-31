import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3Assets from "aws-cdk-lib/aws-s3-assets";
import { MpcNetwork, MpcNetworkProps, MpcNodeConfig } from "./mpc-network";

export interface MpcStandaloneStackProps extends cdk.StackProps {
  /** NEAR RPC URL (e.g., "http://10.0.1.100:3030") */
  nearRpcUrl?: string;
  /** NEAR network id for the chain the MPC indexer follows (e.g., "localnet", "testnet", "mainnet") */
  nearNetworkId?: string;
  /** MPC container environment selector (for the MPC image `start.sh`). For localnet this must be "mpc-localnet". */
  mpcEnv?: string;
  /** NEAR boot nodes (comma-separated list) */
  nearBootNodes?: string;
  /** NEAR genesis file content (base64 encoded) for localnet */
  nearGenesis?: string;
  /** MPC contract ID (e.g., "v1.signer.localnet" for localnet) */
  mpcContractId?: string;
  /** VPC ID (optional - will create new VPC if not provided) */
  vpcId?: string;
  /** Number of MPC nodes (default: 3) */
  nodeCount?: number;
  /** Docker image URI (defaults to Docker Hub image matching GCP production) */
  dockerImageUri?: string;
  /** CPU units per node (default: 512 = 0.5 vCPU) */
  cpu?: number;
  /** Memory per node in MB (default: 1024 = 1 GB) */
  memory?: number;
  /** Import values from another stack (e.g., AWSNodeRunner) */
  importFromStack?: boolean;
  /** Name of stack to import from (default: "AWSNodeRunnerStack") */
  awsNodeRunnerStackName?: string;
}

export class MpcStandaloneStack extends cdk.Stack {
  public readonly mpcNetwork: MpcNetwork;

  constructor(scope: cdk.App, id: string, props: MpcStandaloneStackProps) {
    super(scope, id, props);

    const {
      nearRpcUrl: propsNearRpcUrl,
      nearNetworkId: propsNearNetworkId,
      mpcEnv: propsMpcEnv,
      nearBootNodes: propsNearBootNodes,
      nearGenesis: propsNearGenesis,
      mpcContractId: propsMpcContractId,
      vpcId: propsVpcId,
      nodeCount = 3,
      dockerImageUri,
      cpu,
      memory,
      importFromStack = false,
      awsNodeRunnerStackName = "AWSNodeRunnerStack",
    } = props;

    // Deployment Pattern: Loosely Coupled Architecture
    // 1. Standalone: User provides values via props (from context/env)
    // 2. Integrated: Import from AWSNodeRunner CloudFormation exports
    // Priority: props > CloudFormation imports > defaults
    
    let nearRpcUrl: string;
    let nearNetworkId: string;
    let mpcEnv: string;
    let nearBootNodes: string;
    let nearGenesis: string | undefined;
    let mpcContractId: string;
    let vpcId: string | undefined;

    if (importFromStack) {
      // Import from CloudFormation exports (if AWSNodeRunner stack exists)
      console.log(`📦 Importing configuration from ${awsNodeRunnerStackName} stack...`);
      
      nearRpcUrl = propsNearRpcUrl || cdk.Fn.importValue(`${awsNodeRunnerStackName}-NearRpcUrl`);
      nearNetworkId = propsNearNetworkId || cdk.Fn.importValue(`${awsNodeRunnerStackName}-NearNetworkId`);
      mpcEnv = propsMpcEnv || (nearNetworkId === "localnet" ? "mpc-localnet" : nearNetworkId);
      nearBootNodes = propsNearBootNodes || cdk.Fn.importValue(`${awsNodeRunnerStackName}-NearBootNodes`);
      nearGenesis = propsNearGenesis; // Can't import file content from CFn outputs easily, assume passed via context
      mpcContractId = propsMpcContractId || cdk.Fn.importValue(`${awsNodeRunnerStackName}-MpcContractId`);
      vpcId = propsVpcId || cdk.Fn.importValue(`${awsNodeRunnerStackName}-VpcId`);
    } else {
      // Standalone deployment - use provided values or config.local.json
      console.log("🔧 Standalone deployment - using context/environment/config.local.json configuration");
      
      // Try to load config.local.json for defaults
      let localConfig: any = {};
      try {
        const fs = require('fs');
        const path = require('path');
        const configPath = path.join(__dirname, '..', 'config.local.json');
        if (fs.existsSync(configPath)) {
          localConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          console.log("📄 Loaded config.local.json");
        }
      } catch (e) {
        console.log("⚠️  Could not load config.local.json, using defaults");
      }
      
      nearRpcUrl =
        propsNearRpcUrl ||
        (localConfig.near?.rpcIp
          ? `http://${localConfig.near.rpcIp}:${localConfig.near?.rpcPort || 3030}`
          : "http://localhost:3030");
      nearNetworkId = propsNearNetworkId || localConfig.near?.networkId || "localnet";
      mpcEnv = propsMpcEnv || (nearNetworkId === "localnet" ? "mpc-localnet" : nearNetworkId);
      nearBootNodes = propsNearBootNodes || localConfig.near?.bootNodes || "";
      nearGenesis = propsNearGenesis || localConfig.near?.genesisBase64;  // Read from config!
      mpcContractId = propsMpcContractId || localConfig.mpc?.contractId || "v1.signer.localnet";
      vpcId = propsVpcId || localConfig.aws?.vpcId;
      
      if (nearGenesis) {
        console.log("✅ Using NEAR Base genesis from config (Connected Localnet mode)");
      } else {
        console.log("⚠️  No genesis provided - will use embedded genesis (Standalone mode)");
      }
    }

    // Get or create VPC
    let vpc: ec2.IVpc;
    if (vpcId) {
      // Import existing VPC
      vpc = ec2.Vpc.fromLookup(this, "ImportedVpc", {
        vpcId,
      });
    } else {
      // Create new VPC for MPC nodes
      vpc = new ec2.Vpc(this, "MpcVpc", {
        maxAzs: 2,
        natGateways: 1, // Single NAT gateway for cost savings (can be increased for HA)
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: "public",
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            cidrMask: 24,
            name: "private",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
      });
    }

    // Upload genesis as S3 Asset if provided
    let genesisS3Url: string | undefined;
    if (nearGenesis && nearGenesis.length > 1000) {
      console.log("📦 Uploading genesis as S3 Asset...");
      
      const fs = require('fs');
      const path = require('path');
      
      // Create temp directory
      const tmpDir = path.join(__dirname, '..', '.tmp');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      
      // Write genesis to temp file
      const genesisPath = path.join(tmpDir, 'near-base-genesis.json');
      const genesisContent = Buffer.from(nearGenesis, 'base64').toString('utf8');
      fs.writeFileSync(genesisPath, genesisContent);
      
      console.log(`✅ Genesis file created: ${genesisPath} (${genesisContent.length} bytes)`);
      
      // Upload as CDK Asset
      const genesisAsset = new s3Assets.Asset(this, 'GenesisAsset', {
        path: genesisPath,
      });
      
      genesisS3Url = genesisAsset.s3ObjectUrl;
      console.log(`✅ Genesis will be uploaded to: ${genesisS3Url}`);
    }

    // Generate node configurations
    const nodeConfigs: MpcNodeConfig[] = [];
    for (let i = 0; i < nodeCount; i++) {
      nodeConfigs.push({
        accountId: `mpc-node-${i}.${nearNetworkId === "localnet" ? "node0" : nearNetworkId}`,
        localAddress: `node-${i}.mpc.local`,
        responderId: undefined, // Will default to accountId
      });
    }

    // Create MPC Network
    const mpcNetworkProps: MpcNetworkProps = {
      vpc,
      nearRpcUrl,
      nearNetworkId,
      mpcEnv,
      nearBootNodes,
      nearGenesis,
      mpcContractId,
      nodeConfigs,
      dockerImageUri,
      cpu,
      memory,
      genesisS3Url,  // Pass S3 URL to MpcNetwork
    };

    this.mpcNetwork = new MpcNetwork(this, "MpcNetwork", mpcNetworkProps);

    // Stack outputs
    new cdk.CfnOutput(this, "MpcNetworkId", {
      value: this.stackId,
      description: "MPC Network Stack ID",
    });

    new cdk.CfnOutput(this, "VpcId", {
      value: vpc.vpcId,
      exportName: "MpcVpcId",
    });
  }
}

