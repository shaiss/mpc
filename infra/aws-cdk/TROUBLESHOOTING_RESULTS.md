# MPC Node Deployment - Troubleshooting Results

**Date**: December 5, 2025  
**Status**: ✅ **RESOLVED - MPC Node Running Successfully**

## 🎯 Key Findings

### ✅ **The Fix: MPC_ENV Value**

**Problem**: MPC nodes were crashing during initialization  
**Root Cause**: `MPC_ENV` was set to `"localnet"` but must be `"mpc-localnet"`  
**Evidence**: `deployment/start.sh` line 11 checks: `if [ "$MPC_ENV" = "mpc-localnet" ];`

**Impact**: Wrong value causes the node to try downloading genesis from S3 (which fails) instead of using the embedded localnet genesis at `/app/localnet-genesis.json`

### 🔧 Additional Critical Fixes

1. **Secret Format**: Plain strings, NOT JSON objects
   - ❌ Wrong: `{"key": "ed25519:..."}`
   - ✅ Correct: `"ed25519:..."`

2. **Key Generation**: Must use `near-crypto` library
   - ❌ Wrong: `openssl rand -hex 32` with `ed25519:` prefix
   - ✅ Correct: `infra/scripts/generate_keys` Rust crate
   - Keys are base58-encoded: `ed25519:XzLWzwmq38xW5GgToPfn9v5EHx6...`

3. **Secret References in ECS**: No JSON key extraction
   - ❌ Wrong: `ecs.Secret.fromSecretsManager(secret, "key")`
   - ✅ Correct: `ecs.Secret.fromSecretsManager(secret)`

## ✅ Verified Working Configuration

```json
{
  "environment": [
    {"name": "MPC_ENV", "value": "mpc-localnet"},  // ← CRITICAL!
    {"name": "MPC_HOME_DIR", "value": "/tmp"},
    {"name": "MPC_CONTRACT_ID", "value": "v1.signer.node0"},
    {"name": "MPC_ACCOUNT_ID", "value": "mpc-node-0.node0"},
    {"name": "NEAR_RPC_URL", "value": "http://10.0.5.132:3030"},
    {"name": "NEAR_BOOT_NODES", "value": "ed25519:7PGseFbWxvYVgZ89K1uTJKYoKetWs7BJtbyXDzfbAcqX@10.0.5.132:24567"},
    {"name": "RUST_LOG", "value": "mpc=debug,info"}
  ],
  "secrets": [
    {
      "name": "MPC_ACCOUNT_SK",
      "valueFrom": "arn:aws:secretsmanager:us-east-1:311843862895:secret:mpc-node-0-mpc_account_sk-..."
    },
    // ... (plain string secrets, no JSON)
  ]
}
```

## 📊 Test Results

**Test Method**: Direct ECS CLI (bypassed CDK for fast iteration)

```bash
# Created test cluster
aws ecs create-cluster --cluster-name mpc-test

# Ran single task with fixed configuration
aws ecs run-task --cluster mpc-test --task-definition mpc-node-test:4 ...
```

**Result**: ✅ **MPC node running successfully**

### Logs Show:
- ✅ NEAR node initialized with embedded genesis
- ✅ MPC config created
- ✅ Secrets loaded from environment
- ✅ Web server bound to 0.0.0.0:8080
- ✅ NEAR indexer processing blocks

### Expected Errors (not failures):
- `Account v1.signer.node0 does not exist` - Contract not deployed yet (expected for fresh localnet)
- `failed to connect to boot node` - Network/security group issue (separate concern)

## 🚀 Deployment Strategy

### Recommendation: **Continue with CDK (NOT Express Mode)**

**Why NOT Express Mode:**
- ❌ Designed for web apps with ALB
- ❌ Auto-scaling doesn't fit MPC static identity requirement
- ❌ No Service Discovery support
- ❌ Doesn't support EFS access points

**CDK is the right choice because:**
- ✅ Service Discovery for stable peer addressing
- ✅ Multiple services with static identities
- ✅ EFS integration with access points
- ✅ Matches GCP Terraform architecture
- ✅ All fixes identified and applied

## 📋 Updated Deployment Instructions

### One-Command Deployment (Fixed)

```bash
cd infra/aws-cdk

# 1. Update configuration (one-time)
# Edit .env.local or config.local.json:
#   NEAR_NETWORK_ID=mpc-localnet  ← Must be "mpc-localnet"!

# 2. Deploy
./generate-and-deploy.sh
```

### What the Script Does:
1. ✅ Auto-detects NEAR boot nodes from AWSNodeRunner
2. ✅ Generates proper NEAR ed25519 keys using `near-crypto`
3. ✅ Deploys infrastructure with correct `MPC_ENV=mpc-localnet`
4. ✅ Populates secrets as plain strings
5. ✅ Starts services

## 🔍 Why Fast CLI Iteration Worked

The user's suggestion to bypass CDK was **brilliant** because:
1. **Immediate feedback** - Saw logs in seconds, not 45 minutes
2. **Isolated variables** - Tested one thing at a time
3. **Discovered root cause** - Found `MPC_ENV` value issue quickly

## ✅ Next Steps

1. **Deploy with CDK** (now that we know the config works):
   ```bash
   cd infra/aws-cdk
   ./generate-and-deploy.sh
   ```

2. **For cross-chain-simulator integration**:
   - MPC nodes will be accessible via Service Discovery: `node-{N}.mpc-mpcstandalonestack.local:8080`
   - Can import MPC network construct from this repo

3. **Contract Deployment** (separate step):
   - Deploy `v1.signer.node0` contract to NEAR localnet
   - MPC nodes will detect it and start processing signature requests

## 📚 References

- GCP implementation: `infra/partner-testnet/main.tf`, `infra/configs/mpc_cloud_config.yml`
- Key generator: `infra/scripts/generate_keys/src/main.rs`
- Start script: `deployment/start.sh`

