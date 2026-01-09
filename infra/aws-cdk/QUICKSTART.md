# MPC Node Deployment (AWS) - Quick Start

This guide deploys MPC nodes that **sync to an existing NEAR Base** (AWSNodeRunner localnet) and watch `v1.signer` on that chain.

## Prerequisites

- AWSNodeRunner NEAR Base deployed and reachable from the VPC
- AWS CLI configured (profile recommended)
- Node.js 18+ and npm

## 1) Discover NEAR Base Values (NEVER hardcode)

**Do NOT hardcode** IPs, keys, or IDs. Fetch them dynamically from CloudFormation outputs:

```bash
# Set common vars
PROFILE="shai-sandbox-profile"
REGION="us-east-1"
NEAR_STACK="near-localnet-infrastructure"

# Get NEAR Base IP
NEAR_IP=$(aws cloudformation describe-stacks --stack-name $NEAR_STACK \
  --profile $PROFILE --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='near-instance-private-ip'].OutputValue" --output text)

# Get VPC ID
VPC_ID=$(aws cloudformation describe-stacks --stack-name $NEAR_STACK \
  --profile $PROFILE --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text)

# Get NEAR Instance ID for SSM
NEAR_INSTANCE=$(aws cloudformation describe-stacks --stack-name $NEAR_STACK \
  --profile $PROFILE --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='near-instance-id'].OutputValue" --output text)

echo "NEAR IP: $NEAR_IP"
echo "VPC ID: $VPC_ID"
echo "NEAR Instance: $NEAR_INSTANCE"
```

**Get node_key via SSM** (required for boot_nodes):
```bash
aws ssm start-session --target $NEAR_INSTANCE --profile $PROFILE
# Then run on instance:
cat /home/ubuntu/.near/localnet/node0/node_key.json | jq -r .public_key
# Copy the ed25519:XXXXX value
```

## 2) Configure

From this directory:

```bash
cd infra/aws-cdk
cp config.example.json config.local.json
```

Update `config.local.json` with the **discovered values** from Step 1:
- **`aws.vpcId`**: `${VPC_ID}` from CloudFormation output
- **`near.rpcIp`**: `${NEAR_IP}` from CloudFormation output
- **`near.bootNodes`**: `ed25519:XXXXX@${NEAR_IP}:24567` (key from SSM)
- **`near.genesisBase64`**: base64-encoded NEAR Base `genesis.json`
- **`near.networkId`**: `localnet`
- **`mpc.dockerImage`**: `nearone/mpc-node:3.2.0`

## 2) Deploy the stack

```bash
npm install
npm run build

npx cdk deploy MpcStandaloneStack \
  --profile shai-sandbox-profile \
  --require-approval never
```

## 3) Populate node secrets (required)

The stack creates Secrets Manager secrets with placeholder values. Each instance will **wait on boot** until placeholders are replaced.

```bash
./scripts/generate-test-keys.sh 3
./scripts/update-secrets.sh ./mpc-node-keys.json shai-sandbox-profile
```

## 4) Verify (SSM into an MPC instance)

```bash
aws ssm start-session --target {mpc-instance-id} --profile shai-sandbox-profile
```

On the instance:

```bash
docker ps --filter name=mpc-node
docker logs mpc-node --tail 80
curl -s http://localhost:3030/status
```

## Cleanup

```bash
npx cdk destroy MpcStandaloneStack --profile shai-sandbox-profile --force
```

