# MPC AWS CDK Deployment - Debug Prompt

Use this prompt to start a new Cursor session focused on debugging the MPC AWS CDK deployment.

---

## Prompt for New Cursor Session

```
I am debugging the AWS CDK deployment for NEAR MPC nodes. The deployment is failing with "NotStabilized" errors for ECS services.

**Context**:
- Working directory: `/Users/Shai.Perednik/Documents/code_workspace/near_mobile/cross-chain-simulator/cross-chain-simulator/mpc-repo/infra/aws-cdk`
- Stack name: `MpcStandaloneStack`
- AWS Profile: `shai-sandbox-profile` (already authenticated)
- Three Cursor rules have been created with context:
  - `near-mpc-repo`: MPC repository structure and integration
  - `mpc-aws-infra`: AWS CDK architecture details
  - `aws-cdk-debugging`: Debugging best practices
  - `aws-profile`: AWS CLI profile configuration

**Current Status**:
The stack deployment fails during ECS service creation with "Exceeded attempts to wait" (HandlerErrorCode: NotStabilized). This typically means tasks are crashing on startup or failing health checks.

**Known Issues**:
1. Secrets are created with placeholders ("PLACEHOLDER_REPLACE_ME"). The MPC node might crash if it cannot generate or use these secrets.
2. Cloud Map namespace conflicts occurred in earlier attempts. Code has been updated to use unique namespace names.
3. Docker image: Using `nearone/mpc-node-gcp:testnet-release` (verified to exist).

**What I Need Help With**:
1. Investigate why ECS tasks are not stabilizing:
   - Check stopped task reasons: `aws ecs list-tasks --cluster mpc-nodes --desired-status STOPPED --profile shai-sandbox-profile`
   - Get task details: `aws ecs describe-tasks --cluster mpc-nodes --tasks <task-arn> --profile shai-sandbox-profile`
   - Check CloudWatch logs if available

2. Identify and fix the root cause:
   - Is it secrets configuration?
   - Is it networking/security groups?
   - Is it a missing environment variable?
   - Is it EFS mount permissions?

3. Deploy successfully:
   - Delete the failed stack if needed: `aws cloudformation delete-stack --stack-name MpcStandaloneStack --profile shai-sandbox-profile`
   - Update the code in `lib/mpc-network.ts` if fixes are needed
   - Deploy: `npx cdk deploy --context vpcId=vpc-0ad7ab6659e0293ae --profile shai-sandbox-profile --require-approval never`

**Integration Requirements**:
The MPC nodes need to integrate with:
- NEAR RPC: `http://10.0.5.132:3030` (from AWSNodeRunner)
- Network: `localnet`
- Contract: `v1.signer.node0` (or timestamped variant `v1-signer-*.node0`)

**Reference Materials**:
- GCP implementation: `../partner-testnet/main.tf`
- Container config: `../../deployment/start.sh`
- Environment variables documented in `../../docs/running_an_mpc_node_in_tdx_external_guide.md`
```

---

## Quick Debug Commands

```bash
# Check stack status
aws cloudformation describe-stacks --stack-name MpcStandaloneStack --profile shai-sandbox-profile

# List stopped tasks
aws ecs list-tasks --cluster mpc-nodes --desired-status STOPPED --profile shai-sandbox-profile

# Get task details (replace TASK_ID)
aws ecs describe-tasks --cluster mpc-nodes --tasks <task-id> --profile shai-sandbox-profile

# Check CloudWatch logs (if log group exists)
aws logs tail /aws/ecs/mpc-node-0 --follow --profile shai-sandbox-profile

# Delete stack and retry
aws cloudformation delete-stack --stack-name MpcStandaloneStack --profile shai-sandbox-profile
aws cloudformation wait stack-delete-complete --stack-name MpcStandaloneStack --profile shai-sandbox-profile

# Deploy
cd /Users/Shai.Perednik/Documents/code_workspace/near_mobile/cross-chain-simulator/cross-chain-simulator/mpc-repo/infra/aws-cdk
npm run build
npx cdk deploy --context vpcId=vpc-0ad7ab6659e0293ae --profile shai-sandbox-profile --require-approval never
```

