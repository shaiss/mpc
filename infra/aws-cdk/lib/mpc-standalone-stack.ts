import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { MpcNetwork, MpcNetworkProps, MpcNodeConfig } from "./mpc-network";

export interface MpcStandaloneStackProps extends cdk.StackProps {
  /** NEAR RPC URL (e.g., "http://10.0.1.100:3030") */
  nearRpcUrl?: string;
  /** NEAR network ID (e.g., "localnet", "testnet", "mainnet") */
  nearNetworkId?: string;
  /** NEAR boot nodes (comma-separated list) */
  nearBootNodes?: string;
  /** MPC contract ID (e.g., "v1.signer.node0" for localnet) */
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
      nearBootNodes: propsNearBootNodes,
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
    let nearBootNodes: string;
    let mpcContractId: string;
    let vpcId: string | undefined;

    if (importFromStack) {
      // Import from CloudFormation exports (if AWSNodeRunner stack exists)
      console.log(`📦 Importing configuration from ${awsNodeRunnerStackName} stack...`);
      
      nearRpcUrl = propsNearRpcUrl || cdk.Fn.importValue(`${awsNodeRunnerStackName}-NearRpcUrl`);
      nearNetworkId = propsNearNetworkId || cdk.Fn.importValue(`${awsNodeRunnerStackName}-NearNetworkId`);
      nearBootNodes = propsNearBootNodes || cdk.Fn.importValue(`${awsNodeRunnerStackName}-NearBootNodes`);
      mpcContractId = propsMpcContractId || cdk.Fn.importValue(`${awsNodeRunnerStackName}-MpcContractId`);
      vpcId = propsVpcId || cdk.Fn.importValue(`${awsNodeRunnerStackName}-VpcId`);
    } else {
      // Standalone deployment - use provided values or defaults
      console.log("🔧 Standalone deployment - using context/environment configuration");
      
      nearRpcUrl = propsNearRpcUrl || "http://localhost:3030";
      nearNetworkId = propsNearNetworkId || "mpc-localnet";
      nearBootNodes = propsNearBootNodes || "";
      mpcContractId = propsMpcContractId || "v1.signer.node0";
      vpcId = propsVpcId;
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
      nearBootNodes,
      mpcContractId,
      nodeConfigs,
      dockerImageUri,
      cpu,
      memory,
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

