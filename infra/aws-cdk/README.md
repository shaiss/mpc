# AWS CDK Deployment for NEAR MPC Nodes

This directory contains an AWS CDK implementation for deploying NEAR MPC (Multi-Party Computation) nodes on AWS using ECS Fargate, EFS, and AWS Secrets Manager.

## Architecture

- **Compute**: Amazon ECS on AWS Fargate (serverless, no EC2 management)
- **Storage**: Amazon EFS with dedicated access points per node
- **Secrets**: AWS Secrets Manager for node keys (encrypted with KMS)
- **Networking**: AWS Cloud Map for service discovery (private DNS)
- **Service Architecture**: 3 distinct ECS Services (one per MPC node) for static peer addressing

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 18+ and npm
- AWS CDK CLI (`npm install -g aws-cdk`)

## Local Development Setup

For local development, create a `.env.local` file (gitignored) with your configuration:

```bash
# Copy the example template
cp .env.example .env.local

# Edit with your values
# AWS_PROFILE=shai-sandbox-profile
# VPC_ID=vpc-0ad7ab6659e0293ae
# NEAR_RPC_IP=10.0.5.132
# etc.
```

The deployment scripts (`deploy-mpc-nodes.sh` and `scripts/update-secrets.sh`) will automatically load variables from `.env.local` if it exists. This keeps your personal configuration out of git while making local development easier.

## Configuration

Configuration can be provided via:
1. CDK context: `cdk synth --context nearRpcUrl=http://...`
2. Environment variables: `NEAR_RPC_URL`, `NEAR_NETWORK_ID`, etc.
3. Default values (for localnet development)

### Required Configuration

- `nearRpcUrl`: NEAR RPC endpoint (e.g., `http://10.0.1.100:3030`)
- `nearNetworkId`: NEAR network ID (`localnet`, `testnet`, `mainnet`)
- `nearBootNodes`: Comma-separated list of NEAR boot nodes
- `mpcContractId`: MPC contract ID (e.g., `v1.signer.node0` for localnet)

### Optional Configuration

- `vpcId`: Existing VPC ID (creates new VPC if not provided)
- `nodeCount`: Number of MPC nodes (default: 3)
- `dockerImage`: Docker image (default: `nearone/mpc-node:latest`)
- `cpu`: CPU units per node (default: 512 = 0.5 vCPU)
- `memory`: Memory per node in MB (default: 1024 = 1 GB)

## Usage

### Build

```bash
npm install
npm run build
```

### Synthesize CloudFormation Template

```bash
npx cdk synth
```

### Deploy

```bash
# Set required environment variables
export NEAR_RPC_URL="http://10.0.1.100:3030"
export NEAR_NETWORK_ID="localnet"
export NEAR_BOOT_NODES="ed25519:..."
export MPC_CONTRACT_ID="v1.signer.node0"

# Deploy stack
npx cdk deploy --profile <your-aws-profile>
```

### Populate Secrets

After deployment, populate the Secrets Manager secrets with actual MPC node keys:

```bash
# For each node (0, 1, 2) and each key
aws secretsmanager put-secret-value \
  --secret-id mpc-node-0-mpc_account_sk \
  --secret-string "ed25519:..." \
  --profile <your-aws-profile>
```

Required secrets per node:
- `mpc-node-{N}-mpc_account_sk`
- `mpc-node-{N}-mpc_p2p_private_key`
- `mpc-node-{N}-mpc_cipher_pk`
- `mpc-node-{N}-mpc_sign_sk`
- `mpc-node-{N}-mpc_secret_store_key`

## Integration with AWSNodeRunner

To integrate with an existing `AWSNodeRunner` VPC:

```bash
# Get VPC ID from AWSNodeRunner stack
VPC_ID=$(aws cloudformation describe-stacks \
  --stack-name near-localnet-infrastructure \
  --query 'Stacks[0].Outputs[?OutputKey==`NearLocalnetVpcId`].OutputValue' \
  --output text \
  --profile <your-aws-profile>)

# Deploy with existing VPC
npx cdk deploy --context vpcId=$VPC_ID --profile <your-aws-profile>
```

## Outputs

The stack exports:
- `MpcClusterName`: ECS cluster name
- `MpcFileSystemId`: EFS file system ID
- `MpcNamespaceId`: Cloud Map namespace ID
- `MpcNode{N}ServiceName`: Service name for each node
- `VpcId`: VPC ID (if new VPC created)

## Directory Structure

```
aws-cdk/
├── bin/
│   └── mpc-app.ts          # CDK app entry point
├── lib/
│   ├── mpc-network.ts       # Reusable MpcNetwork construct
│   └── mpc-standalone-stack.ts  # Standalone deployment stack
├── cdk.json                 # CDK configuration
├── package.json             # Dependencies
└── README.md                # This file
```

## Contributing

This code is designed to be contributed back to the `near/mpc` repository as an alternative to the existing GCP Terraform implementation. It follows AWS best practices and can be used standalone or integrated with other AWS infrastructure.
