# AWS CDK Deployment Guide for NEAR MPC Nodes

## Prerequisites

1. **AWS CLI configured** with profile `shai-sandbox-profile`
2. **NEAR RPC Node running** (from AWSNodeRunner)
3. **VPC ID** from AWSNodeRunner deployment
4. **Node.js and npm** installed
5. **CDK bootstrapped** in your AWS account

## Architecture Overview

This CDK stack deploys 3 MPC nodes on AWS ECS Fargate:
- **Compute**: ECS Fargate (0.5 vCPU, 1GB RAM per node)
- **Storage**: EFS with access points (one per node)
- **Networking**: Cloud Map for service discovery
- **Secrets**: AWS Secrets Manager for keys

## Quick Start (Localnet)

### 1. Delete Old Stack (if exists)

```bash
cd /Users/Shai.Perednik/Documents/code_workspace/near_mobile/cross-chain-simulator/cross-chain-simulator/mpc-repo/infra/aws-cdk

aws cloudformation delete-stack \
  --stack-name MpcStandaloneStack \
  --profile shai-sandbox-profile
  
# Wait for deletion to complete
aws cloudformation wait stack-delete-complete \
  --stack-name MpcStandaloneStack \
  --profile shai-sandbox-profile
```

### 2. Get NEAR Node Information

From your AWSNodeRunner deployment:

```bash
# Get NEAR RPC private IP (should be something like http://10.0.5.132:3030)
NEAR_RPC_URL="http://10.0.5.132:3030"

# Get boot nodes from NEAR node
NEAR_BOOT_NODES=$(curl -s $NEAR_RPC_URL/status | jq -r '.node_key' | sed 's/^/ed25519:/')
# Append the IP:port
NEAR_BOOT_NODES="${NEAR_BOOT_NODES}@10.0.5.132:24567"

# Verify it works
curl -s $NEAR_RPC_URL/status | jq
```

### 3. Deploy the Stack

The stack is now configured with correct defaults for localnet:

```bash
npx cdk deploy \
  --context vpcId=vpc-0ad7ab6659e0293ae \
  --context nearRpcUrl="$NEAR_RPC_URL" \
  --context nearBootNodes="$NEAR_BOOT_NODES" \
  --profile shai-sandbox-profile \
  --require-approval never
```

**Note**: The stack will deploy with placeholder secrets. You MUST populate them before the services can start successfully.

### 4. Populate Secrets

#### Option A: Quick Test with Generated Keys

```bash
# Make scripts executable
chmod +x scripts/*.sh

# Generate test keys (for localnet only!)
./scripts/generate-test-keys.sh 3

# This creates mpc-node-keys.json with test keys

# Update AWS Secrets Manager
./scripts/update-secrets.sh mpc-node-keys.json shai-sandbox-profile
```

#### Option B: Manual Secret Population

For each node (0, 1, 2), update the following secrets:

```bash
# Replace with your actual keys
NODE_ID=0

aws secretsmanager put-secret-value \
  --secret-id "mpc-node-${NODE_ID}-mpc_account_sk" \
  --secret-string '{"key":"ed25519:YOUR_ACCOUNT_SECRET_KEY_HERE"}' \
  --profile shai-sandbox-profile

aws secretsmanager put-secret-value \
  --secret-id "mpc-node-${NODE_ID}-mpc_p2p_private_key" \
  --secret-string '{"key":"ed25519:YOUR_P2P_PRIVATE_KEY_HERE"}' \
  --profile shai-sandbox-profile

aws secretsmanager put-secret-value \
  --secret-id "mpc-node-${NODE_ID}-mpc_secret_store_key" \
  --secret-string '{"key":"11111111111111111111111111111111"}' \
  --profile shai-sandbox-profile
```

### 5. Start ECS Services

After populating secrets, start the services:

```bash
aws ecs update-service \
  --cluster mpc-nodes \
  --service node-0 \
  --desired-count 1 \
  --profile shai-sandbox-profile

aws ecs update-service \
  --cluster mpc-nodes \
  --service node-1 \
  --desired-count 1 \
  --profile shai-sandbox-profile

aws ecs update-service \
  --cluster mpc-nodes \
  --service node-2 \
  --desired-count 1 \
  --profile shai-sandbox-profile
```

## Debugging

### Check Service Status

```bash
aws ecs describe-services \
  --cluster mpc-nodes \
  --services node-0 node-1 node-2 \
  --profile shai-sandbox-profile \
  | jq '.services[] | {name: .serviceName, status: .status, running: .runningCount, desired: .desiredCount}'
```

### View Container Logs

```bash
# Get log group names from CDK outputs
aws logs tail \
  MpcStandaloneStack-MpcNetworkNode0TaskDefinitionNode0ContainerLogGroup2C63C370-rmIlUL6BTl9Z \
  --follow \
  --profile shai-sandbox-profile
```

### Check Stopped Tasks

```bash
aws ecs list-tasks \
  --cluster mpc-nodes \
  --desired-status STOPPED \
  --profile shai-sandbox-profile \
  | jq -r '.taskArns[]' \
  | head -1 \
  | xargs -I {} aws ecs describe-tasks \
      --cluster mpc-nodes \
      --tasks {} \
      --profile shai-sandbox-profile \
  | jq '.tasks[0].stoppedReason'
```

## Configuration Reference

### Environment Variables (in CDK)

| Variable | Default | Description |
|----------|---------|-------------|
| `nearRpcUrl` | `http://localhost:3030` | NEAR RPC endpoint (private IP) |
| `nearNetworkId` | `mpc-localnet` | Chain ID (MUST be "mpc-localnet" for localnet) |
| `nearBootNodes` | `` | Comma-separated boot nodes |
| `mpcContractId` | `v1.signer.node0` | MPC contract account ID |
| `vpcId` | (required) | VPC ID from context |
| `nodeCount` | `3` | Number of MPC nodes |
| `dockerImage` | `nearone/mpc-node-gcp:testnet-release` | Docker image |
| `cpu` | `512` | vCPU units (512 = 0.5 vCPU) |
| `memory` | `1024` | Memory in MB |

### Required Secrets

Each node requires 3 secrets in AWS Secrets Manager:

1. **mpc-node-{i}-mpc_account_sk**: NEAR account secret key (ed25519)
2. **mpc-node-{i}-mpc_p2p_private_key**: libp2p private key (ed25519)
3. **mpc-node-{i}-mpc_secret_store_key**: Encryption key (32 chars, any value for localnet)

## Troubleshooting

### Issue: Tasks immediately stop after starting

**Cause**: Secrets contain placeholder values

**Fix**: Run `./scripts/update-secrets.sh` to populate secrets

### Issue: "NotStabilized" error during deployment

**Cause**: Services cannot start due to missing/invalid configuration

**Fix**:
1. Delete the stack
2. Verify NEAR RPC is accessible from the VPC
3. Populate secrets before deployment
4. Re-deploy

### Issue: Containers can't reach NEAR RPC

**Cause**: Security group or routing issue

**Fix**:
1. Verify NEAR node security group allows ingress from MPC nodes SG
2. Check NEAR RPC is listening on private IP (not just 127.0.0.1)
3. Test connectivity from within VPC: `curl http://10.0.5.132:3030/status`

### Issue: Boot nodes connection fails

**Cause**: Invalid boot nodes format or unreachable nodes

**Fix**:
1. Verify boot nodes format: `ed25519:PUBKEY@IP:PORT`
2. Ensure port 24567 is accessible between nodes
3. Check Cloud Map DNS is resolving node addresses

## Production Considerations

For testnet/mainnet deployments:

1. **Increase Resources**: Use larger CPU/memory (e.g., 4 vCPU, 8GB RAM)
2. **Secure Secrets**: Generate keys securely, never commit to git
3. **Multi-AZ**: Deploy across multiple availability zones
4. **Monitoring**: Set up CloudWatch alarms for node health
5. **Backup**: Regular EFS snapshots for node data
6. **TLS**: Enable TLS for node-to-node communication
7. **Access Control**: Restrict security groups to known IP ranges

## Integration with Cross-Chain Simulator

After successful deployment, export MPC node endpoints:

```bash
aws servicediscovery list-services \
  --filters Name=NAMESPACE_ID,Values=$(aws servicediscovery list-namespaces --profile shai-sandbox-profile | jq -r '.Namespaces[] | select(.Name | contains("mpc")) | .Id') \
  --profile shai-sandbox-profile \
  | jq -r '.Services[] | "http://\(.Name).mpc-mpcstandalonestack.local:8080"'
```

These endpoints can be used by the cross-chain-simulator for signature requests.

## References

- [NEAR MPC Repository](https://github.com/near/mpc)
- [Localnet Setup Guide](../../docs/localnet/localnet.md)
- [MPC Node Configuration](../../deployment/start.sh)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)

