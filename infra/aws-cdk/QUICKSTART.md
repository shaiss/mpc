# MPC Node Deployment (AWS) - Quick Start

This guide deploys MPC nodes that **sync to an existing NEAR Base** (AWSNodeRunner localnet) and watch `v1.signer` on that chain.

## Prerequisites

- AWSNodeRunner NEAR Base deployed and reachable from the VPC
- AWS CLI configured (profile recommended)
- Node.js 18+ and npm

## 1) Configure

From this directory:

```bash
cd infra/aws-cdk
cp config.example.json config.local.json
```

Update `config.local.json` with:
- **`aws.vpcId`**: the VPC ID used by NEAR Base
- **`near.rpcIp`**: NEAR Base private IP
- **`near.bootNodes`**: `{node_key}@{near-ip}:24567`
- **`near.genesisBase64`**: base64-encoded NEAR Base `genesis.json`
- **`near.networkId`**: `localnet`
- **`mpc.dockerImage`**: `nearone/mpc-node:3.1.0`

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

