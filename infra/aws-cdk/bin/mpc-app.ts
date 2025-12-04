#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { MpcStandaloneStack } from "../lib/mpc-standalone-stack";

const app = new cdk.App();

// Get configuration from environment variables or context
// This supports three deployment patterns:
// 1. Standalone: User provides values via context (--context vpcId=...)
// 2. Integrated: Import from AWSNodeRunner stack exports (if available)
// 3. Composed: Parent stack passes values directly

// Try context first, then CloudFormation imports (if available), then defaults
// Note: CloudFormation imports are evaluated at deploy time, not synth time
const nearRpcUrl = app.node.tryGetContext("nearRpcUrl") || process.env.NEAR_RPC_URL || "http://localhost:3030";
// IMPORTANT: For localnet, MPC nodes expect "mpc-localnet" as the chain-id (see deployment/start.sh line 11)
const nearNetworkId = app.node.tryGetContext("nearNetworkId") || process.env.NEAR_NETWORK_ID || "mpc-localnet";
const nearBootNodes = app.node.tryGetContext("nearBootNodes") || process.env.NEAR_BOOT_NODES || "";
const mpcContractId = app.node.tryGetContext("mpcContractId") || process.env.MPC_CONTRACT_ID || "v1.signer.node0";
const vpcId = app.node.tryGetContext("vpcId") || process.env.VPC_ID;
const nodeCount = parseInt(app.node.tryGetContext("nodeCount") || process.env.MPC_NODE_COUNT || "3", 10);
const dockerImageUri = app.node.tryGetContext("dockerImageUri") || process.env.MPC_DOCKER_IMAGE_URI;
const dockerImageTag = app.node.tryGetContext("dockerImageTag") || process.env.MPC_DOCKER_IMAGE_TAG;
const cpu = parseInt(app.node.tryGetContext("cpu") || process.env.MPC_CPU || "512", 10);
const memory = parseInt(app.node.tryGetContext("memory") || process.env.MPC_MEMORY || "1024", 10);

// Configuration for importing from AWSNodeRunner stack (if deployed)
// Set these to match your AWSNodeRunner stack's export names
const importFromStack = app.node.tryGetContext("importFromStack") === "true" || process.env.IMPORT_FROM_STACK === "true";
const awsNodeRunnerStackName = app.node.tryGetContext("awsNodeRunnerStackName") || process.env.AWS_NODE_RUNNER_STACK || "AWSNodeRunnerStack";

new MpcStandaloneStack(app, "MpcStandaloneStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
  nearRpcUrl,
  nearNetworkId,
  nearBootNodes,
  mpcContractId,
  vpcId,
  nodeCount,
  dockerImageUri,
  imageTag: dockerImageTag,
  cpu,
  memory,
  // Optional: Enable import from another stack
  importFromStack,
  awsNodeRunnerStackName,
});

app.synth();

