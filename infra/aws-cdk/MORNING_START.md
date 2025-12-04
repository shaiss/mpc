# Fresh Start - MPC Node Deployment

**Morning Prompt**: Copy this into your AI assistant to resume deployment

---

## Context

We debugged NEAR MPC node deployment on AWS ECS last night. Found and fixed **6 critical issues**:

1. ✅ Wrong `MPC_ENV` (was "localnet", should be "mpc-localnet")
2. ✅ Placeholder secrets (now auto-generate SECRET_STORE_KEY)
3. ✅ Missing `NEAR_RPC_URL` environment variable
4. ✅ Empty boot nodes (documented how to get them)
5. ✅ Manual architecture (now loosely-coupled with CloudFormation exports)
6. ✅ Missing EFS NFS security group rule (port 2049)

**All fixes are in code**. Last session ended with stack stuck in `CREATE_IN_PROGRESS` due to EFS mount failures. The fix is ready but not deployed yet.

**Current Location**: `/Users/Shai.Perednik/Documents/code_workspace/near_mobile/cross-chain-simulator/cross-chain-simulator/mpc-repo/infra/aws-cdk`

**Documentation**: 
- `SESSION_REPORT_2025-12-03.md` - Complete debugging session report
- `NEXT_STEPS.md` - Detailed deployment steps
- `DEPLOYMENT_GUIDE.md` - Full deployment guide
- `INTEGRATION_GUIDE.md` - Architecture patterns

---

## Task: Clean Deployment with All Fixes

**Objective**: Delete stuck stack and deploy MPC nodes with all 6 fixes applied.

**Time Estimate**: 30-45 minutes

**Success Criteria**:
- ✅ ECS services running (runningCount: 1)
- ✅ No `ResourceInitializationError` in service events
- ✅ CloudWatch logs showing "Near node initialized"
- ✅ Containers stay running (don't restart)

---

## Step-by-Step Commands

### 1. Delete Stuck Stack (5 min)

```bash
cd /Users/Shai.Perednik/Documents/code_workspace/near_mobile/cross-chain-simulator/cross-chain-simulator/mpc-repo/infra/aws-cdk

# Delete the stuck stack
aws cloudformation delete-stack \
  --stack-name MpcStandaloneStack \
  --profile shai-sandbox-profile

# Wait for deletion to complete
aws cloudformation wait stack-delete-complete \
  --stack-name MpcStandaloneStack \
  --profile shai-sandbox-profile

echo "✅ Stack deleted successfully"
```

### 2. Deploy with All Fixes (10 min)

```bash
# Deploy stack with corrected configuration
npx cdk deploy \
  --context vpcId=vpc-0ad7ab6659e0293ae \
  --context nearRpcUrl="http://10.0.5.132:3030" \
  --context nearBootNodes="" \
  --context nearNetworkId="mpc-localnet" \
  --profile shai-sandbox-profile \
  --require-approval never

echo "✅ Stack deployed"
```

**Watch for**: Should complete without errors and create all resources

### 3. Populate Secrets (2 min)

```bash
# Generate test keys for all 3 nodes
for i in 0 1 2; do
  echo "Generating keys for node-$i..."
  
  # Generate keys
  echo "{\"key\":\"ed25519:$(openssl rand -hex 32)\"}" > /tmp/account_sk_$i.json
  echo "{\"key\":\"ed25519:$(openssl rand -hex 32)\"}" > /tmp/p2p_key_$i.json
  echo "{\"key\":\"$(openssl rand -hex 16)\"}" > /tmp/secret_store_$i.json
  
  # Update AWS Secrets Manager
  aws secretsmanager put-secret-value \
    --secret-id "mpc-node-$i-mpc_account_sk" \
    --secret-string "$(cat /tmp/account_sk_$i.json)" \
    --profile shai-sandbox-profile --region us-east-1 > /dev/null
  
  aws secretsmanager put-secret-value \
    --secret-id "mpc-node-$i-mpc_p2p_private_key" \
    --secret-string "$(cat /tmp/p2p_key_$i.json)" \
    --profile shai-sandbox-profile --region us-east-1 > /dev/null
  
  aws secretsmanager put-secret-value \
    --secret-id "mpc-node-$i-mpc_secret_store_key" \
    --secret-string "$(cat /tmp/secret_store_$i.json)" \
    --profile shai-sandbox-profile --region us-east-1 > /dev/null
  
  echo "  ✅ Node-$i secrets updated"
done

echo "✅ All secrets populated"
```

### 4. Start ECS Services (1 min)

```bash
# Start all 3 services
for i in 0 1 2; do
  echo "Starting node-$i..."
  aws ecs update-service \
    --cluster mpc-nodes \
    --service "node-$i" \
    --desired-count 1 \
    --profile shai-sandbox-profile \
    --region us-east-1 > /dev/null
  echo "  ✅ node-$i started"
done

echo "✅ All services started"
```

### 5. Monitor Service Status (5-10 min)

```bash
# Watch service status (run in separate terminal or use watch)
watch -n 5 'aws ecs describe-services --cluster mpc-nodes --services node-0 node-1 node-2 --profile shai-sandbox-profile | jq ".services[] | {name: .serviceName, running: .runningCount, desired: .desiredCount, status: .status}"'
```

**Expected**: After 2-3 minutes, should see `runningCount: 1` for all services

**If stuck at 0**: Check service events for errors

### 6. Check for EFS Mount Success (Critical!)

```bash
# Check service events - should NOT see ResourceInitializationError
aws ecs describe-services \
  --cluster mpc-nodes \
  --services node-0 node-1 node-2 \
  --profile shai-sandbox-profile \
  | jq '.services[] | {name: .serviceName, events: .events[0:3]}'
```

**Success**: No mention of "ResourceInitializationError" or "mount.nfs4"  
**Failure**: If you see EFS mount errors, there's still a security group issue

### 7. Check CloudWatch Logs (5 min)

```bash
# Find log group
LOG_GROUP=$(aws logs describe-log-groups --profile shai-sandbox-profile | jq -r '.logGroups[] | select(.logGroupName | contains("Node0Container")) | .logGroupName' | head -1)

echo "Log group: $LOG_GROUP"

# Tail logs
aws logs tail "$LOG_GROUP" --follow --profile shai-sandbox-profile
```

**Expected Log Output**:
```
Initializing Near node
Near node initialized
Near node config updated
MPC node initialized
MPC node config updated
secrets.json generated successfully
Starting mpc node...
```

**Red Flags**:
- "Error: MPC_P2P_PRIVATE_KEY and MPC_ACCOUNT_SK must be provided" → Secrets issue
- "mount.nfs4: mount system call failed" → EFS security group issue (shouldn't happen now)
- No logs at all → Infrastructure issue

---

## Troubleshooting Quick Reference

### Services Won't Start (runningCount stays 0)

**Check service events**:
```bash
aws ecs describe-services --cluster mpc-nodes --services node-0 --profile shai-sandbox-profile | jq '.services[0].events[0:5]'
```

**Common Issues**:
- `ResourceInitializationError` → Security group or EFS issue
- `CannotPullContainerError` → Docker image issue
- `Essential container exited` → Application error (check logs)

### EFS Mount Still Failing

**Verify security groups**:
```bash
# Get EFS file system details
aws efs describe-file-systems --profile shai-sandbox-profile | jq '.FileSystems[] | select(.Tags[]? | select(.Key=="Name" and (.Value | contains("Mpc"))))'

# Get security group ID from above, then check rules
aws ec2 describe-security-groups --group-ids sg-XXXXX --profile shai-sandbox-profile | jq '.SecurityGroups[0].IpPermissions'
```

**Should see**: Inbound rule allowing TCP port 2049 from ECS security group

### Containers Start but Immediately Crash

**Check logs for errors**:
- Missing environment variables
- Invalid secret format
- NEAR RPC unreachable
- Contract not deployed

---

## Success Indicators

✅ **Service Status**:
```json
{
  "name": "node-0",
  "running": 1,
  "desired": 1,
  "status": "ACTIVE"
}
```

✅ **Service Events** (No errors):
```json
{
  "message": "(service node-0) has reached a steady state."
}
```

✅ **CloudWatch Logs**:
```
Near node initialized
MPC node initialized
Starting mpc node...
```

✅ **Task Running** (No restarts for 5+ minutes)

---

## If Issues Persist

1. **Read the session report**: `SESSION_REPORT_2025-12-03.md`
2. **Check cursor rules**: `.cursor/rules/efs-ecs-integration.mdc`
3. **Review deployment guide**: `DEPLOYMENT_GUIDE.md`

### Quick Diagnosis

**No CloudWatch logs** → Infrastructure issue (EFS, networking, secrets)  
**Has CloudWatch logs** → Application issue (environment vars, NEAR connectivity)  
**Services stuck at 0** → Check service events for placement errors  
**Containers restart loop** → Check logs for application errors

---

## After Successful Deployment

### Verify MPC Node Endpoints

```bash
# Get Cloud Map service discovery hostname
# (Note: Only accessible from within VPC)

# Check if nodes are responsive (requires access from within VPC)
# curl http://node-0.mpc-mpcstandalonestack.local:8080/public_data
```

### Next Steps

1. Deploy MPC contract (`v1.signer.node0`) to NEAR localnet
2. Configure boot nodes properly (get from NEAR node)
3. Test signature generation
4. Integrate with cross-chain-simulator

---

## Configuration Reference

**VPC**: `vpc-0ad7ab6659e0293ae`  
**NEAR RPC**: `http://10.0.5.132:3030`  
**Network**: `mpc-localnet`  
**Contract**: `v1.signer.node0`  
**AWS Profile**: `shai-sandbox-profile`  
**Region**: `us-east-1`

**Stack Name**: `MpcStandaloneStack`  
**Cluster**: `mpc-nodes`  
**Services**: `node-0`, `node-1`, `node-2`

---

## Summary

**What We're Doing**: Clean deployment of MPC nodes with 6 critical fixes  
**Expected Duration**: 30-45 minutes  
**Success Probability**: 85%  
**Key Risk**: May discover app-level issues after infrastructure works  

**All fixes are ready in code. Just need to deploy and verify!** 🚀

