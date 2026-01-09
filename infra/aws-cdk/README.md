# AWS CDK Deployment for NEAR MPC Nodes (AWS)

This directory contains an AWS CDK implementation for deploying NEAR MPC (Multi-Party Computation) nodes on AWS using:

- **EC2** (one instance per MPC node)
- **EBS** (persistent `/data` volume per node)
- **AWS Secrets Manager** (node keys)
- **AWS Cloud Map** (private DNS for node addressing)
- **S3 genesis distribution** (for connected-localnet mode; avoids EC2 UserData size limits)

## Key Concepts

- **`nearNetworkId`**: NEAR network id of the chain MPC syncs to (for localnet this is **`localnet`**)
- **`mpcEnv`**: MPC container env selector consumed by the image `start.sh`
  - localnet must be **`mpc-localnet`**
  - testnet/mainnet typically use **`testnet` / `mainnet`**

## Localnet (Connected to AWSNodeRunner NEAR Base)

MPC nodes run a NEAR indexer node that **syncs to NEAR Base** and watches `v1.signer` on that chain.

**Critical requirements**:
- **Genesis**: MPC nodes must use the **NEAR Base genesis** (this stack distributes it via S3)
- **Boot nodes**: must point at the NEAR Base node (`node_key@{ip}:24567`)
- **Accounts**: MPC node accounts must exist on NEAR Base (expected pattern: `mpc-node-{i}.node0`)

## Quick Start

See [QUICKSTART.md](./QUICKSTART.md).

## Configuration

The recommended approach is to keep configuration in `config.local.json` (gitignored in practice) and deploy without passing lots of CDK context flags.

### Required values for connected-localnet

- `aws.vpcId`
- `near.rpcIp`, `near.rpcPort`
- `near.bootNodes`
- `near.genesisBase64`
- `near.networkId` = `localnet`
- `mpc.contractId` (default: `v1.signer.localnet`)
- `mpc.dockerImage` (default: `nearone/mpc-node:3.2.0`)

## Deploy

```bash
cd infra/aws-cdk
npm install
npm run build

npx cdk deploy MpcStandaloneStack \
  --profile shai-sandbox-profile \
  --require-approval never
```

## Populate Secrets (Required)

This stack creates the per-node Secrets Manager secrets with placeholder values. The instances will **wait on boot** until those placeholders are replaced.

```bash
cd infra/aws-cdk

./scripts/generate-test-keys.sh 3
./scripts/update-secrets.sh ./mpc-node-keys.json shai-sandbox-profile
```

### Secrets Architecture

Each MPC node requires three secrets stored in AWS Secrets Manager:
- `mpc-node-{i}-mpc_account_sk` - NEAR account secret key (ed25519:...)
- `mpc-node-{i}-mpc_p2p_private_key` - P2P network key (ed25519:...)
- `mpc-node-{i}-mpc_secret_store_key` - 32-character hex string for local storage encryption

**CRITICAL: Secrets are fetched during UserData execution only.**

When restarting MPC containers manually (e.g., via SSM for troubleshooting), you MUST:
1. Fetch secrets from Secrets Manager before starting the container
2. Pass them as `-e` environment variables to `docker run`

Example for manual restart:
```bash
NODE_INDEX=0
AWS_REGION=us-east-1

MPC_ACCOUNT_SK=$(aws secretsmanager get-secret-value --secret-id "mpc-node-${NODE_INDEX}-mpc_account_sk" --region $AWS_REGION --query SecretString --output text | tr -d '\n')
MPC_P2P_PRIVATE_KEY=$(aws secretsmanager get-secret-value --secret-id "mpc-node-${NODE_INDEX}-mpc_p2p_private_key" --region $AWS_REGION --query SecretString --output text | tr -d '\n')
MPC_SECRET_STORE_KEY=$(aws secretsmanager get-secret-value --secret-id "mpc-node-${NODE_INDEX}-mpc_secret_store_key" --region $AWS_REGION --query SecretString --output text | tr -d '\n')

docker run -d --name mpc-node --restart=always --net=host \
  -v /data:/data \
  -e MPC_HOME_DIR="/data" \
  -e MPC_ACCOUNT_SK="$MPC_ACCOUNT_SK" \
  -e MPC_P2P_PRIVATE_KEY="$MPC_P2P_PRIVATE_KEY" \
  -e MPC_SECRET_STORE_KEY="$MPC_SECRET_STORE_KEY" \
  -e RUST_BACKTRACE=full \
  -e RUST_LOG=mpc=debug,info \
  --entrypoint /app/mpc-node \
  nearone/mpc-node:3.2.0 start local
```

**Failure mode:** If secrets are empty or malformed, the container crashes with:
- `invalid local storage aes key hex` (missing MPC_SECRET_STORE_KEY)
- `ERROR: MPC_ACCOUNT_SK must start with 'ed25519:'` (malformed account key)

## Destroy

```bash
npx cdk destroy MpcStandaloneStack --profile shai-sandbox-profile --force
```
