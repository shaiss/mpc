# MPC Node Deployment - Quick Start

This guide shows how to deploy MPC nodes that integrate with your AWSNodeRunner NEAR localnet deployment.

## Prerequisites

1. AWSNodeRunner stack deployed (provides NEAR localnet node)
2. AWS CLI configured with appropriate credentials
3. Node.js 18+ and npm installed
4. `jq` installed for JSON processing

## One-Command Deployment

### Option 1: Using config.local.json (Recommended)

```bash
# 1. Copy the example config
cp config.example.json config.local.json

# 2. Edit config.local.json with your values from AWSNodeRunner:
#    - VPC ID from near-localnet-common stack
#    - NEAR RPC IP from near-localnet-infrastructure stack
#    - AWS profile name

# 3. Run the deployment script
./generate-and-deploy.sh
```

The script will:
- ✅ Auto-detect NEAR node configuration from CloudFormation
- ✅ Generate test MPC keys automatically
- ✅ Deploy all infrastructure (ECS, EFS, secrets, etc.)
- ✅ Populate secrets with generated keys
- ✅ Start MPC node services

### Option 2: Using .env.local

```bash
# 1. Create .env.local with your configuration
cat > .env.local <<EOF
AWS_PROFILE=shai-sandbox-profile
VPC_ID=vpc-0ad7ab6659e0293ae
NEAR_RPC_IP=10.0.5.132
NEAR_RPC_PORT=3030
NEAR_P2P_PORT=24567
NODE_COUNT=3
NEAR_NETWORK_ID=localnet
MPC_CONTRACT_ID=v1.signer.node0
MPC_DOCKER_IMAGE_URI=nearone/mpc-node-gcp:testnet-release
EOF

# 2. Run the deployment script
./generate-and-deploy.sh
```

## Get Configuration from AWSNodeRunner

If you need to find your AWSNodeRunner configuration:

```bash
# Get VPC ID
aws cloudformation describe-stacks \
  --stack-name near-localnet-common \
  --query 'Stacks[0].Outputs[?OutputKey==`VpcId`].OutputValue' \
  --output text

# Get NEAR RPC IP
aws cloudformation describe-stacks \
  --stack-name near-localnet-infrastructure \
  --query 'Stacks[0].Outputs[?OutputKey==`nearinstanceprivateip`].OutputValue' \
  --output text
```

## Manual Deployment (Step-by-Step)

If you prefer to run each step manually:

```bash
# 1. Install dependencies
npm install

# 2. Build TypeScript
npm run build

# 3. Generate MPC keys
./scripts/generate-test-keys.sh 3

# 4. Deploy CDK (replace values with yours)
npx cdk deploy \
  --profile shai-sandbox-profile \
  --context vpcId="vpc-xxx" \
  --context nearRpcUrl="http://10.0.5.132:3030" \
  --context nearNetworkId="localnet" \
  --context nodeCount="3" \
  --context dockerImageUri="nearone/mpc-node-gcp:testnet-release" \
  --require-approval never

# 5. Populate secrets
./scripts/update-secrets.sh mpc-node-keys.json shai-sandbox-profile
```

## Verify Deployment

```bash
# Check service status
aws ecs describe-services \
  --cluster mpc-nodes \
  --services node-0 node-1 node-2 \
  --profile shai-sandbox-profile \
  | jq '.services[] | {name: .serviceName, running: .runningCount, desired: .desiredCount}'

# View logs
aws logs tail MpcStandaloneStack-MpcNetworkNode0TaskDefinitionNode0ContainerLogGroup* \
  --follow \
  --profile shai-sandbox-profile
```

## Architecture

The deployment creates:
- **ECS Cluster**: `mpc-nodes` (Fargate)
- **3 ECS Services**: `node-0`, `node-1`, `node-2`
- **EFS File System**: Shared persistent storage with 3 access points
- **Service Discovery**: Private DNS via AWS Cloud Map
- **Secrets Manager**: 9 secrets (3 per node: account key, P2P key, store key)
- **Security Groups**: Configured for MPC inter-node communication

## Clean Up

```bash
# Delete the stack
npx cdk destroy --profile shai-sandbox-profile

# Note: EFS file systems and some secrets may be retained based on removal policy
```

## Troubleshooting

### Tasks failing to start

Check the logs to see why tasks are failing:

```bash
aws logs tail <log-group-name> --follow --profile shai-sandbox-profile
```

Common issues:
- **Invalid secrets**: Make sure `update-secrets.sh` ran successfully
- **EFS mount issues**: Check security group rules allow NFS (port 2049)
- **Docker image issues**: Verify the image URI is correct and accessible

### Need to regenerate keys

```bash
# Generate new keys
./scripts/generate-test-keys.sh 3

# Update secrets
./scripts/update-secrets.sh mpc-node-keys.json shai-sandbox-profile

# Restart services to pick up new secrets
for i in 0 1 2; do
  aws ecs update-service \
    --cluster mpc-nodes \
    --service node-$i \
    --force-new-deployment \
    --profile shai-sandbox-profile
done
```

