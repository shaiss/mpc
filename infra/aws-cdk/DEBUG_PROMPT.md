# MPC AWS CDK Deployment - Debug Prompt

Use this prompt to start a new Cursor session focused on debugging the MPC AWS CDK deployment.

---

## Prompt for New Cursor Session

```
I am debugging the AWS CDK deployment for NEAR MPC nodes. The deployment is failing with "NotStabilized" errors for ECS services.

**Context**:
- Working directory: `infra/aws-cdk`
- Stack name: `MpcStandaloneStack`
- AWS Profile: `<your-aws-profile>` (already authenticated)
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
   - Check stopped task reasons: `aws ecs list-tasks --cluster mpc-nodes --desired-status STOPPED --profile "${AWS_PROFILE:-<your-aws-profile>}"`
   - Get task details: `aws ecs describe-tasks --cluster mpc-nodes --tasks <task-arn> --profile "${AWS_PROFILE:-<your-aws-profile>}"`
   - Check CloudWatch logs if available

2. Identify and fix the root cause:
   - Is it secrets configuration?
   - Is it networking/security groups?
   - Is it a missing environment variable?
   - Is it EFS mount permissions?

3. Deploy successfully:
   - Delete the failed stack if needed: `aws cloudformation delete-stack --stack-name MpcStandaloneStack --profile "${AWS_PROFILE:-<your-aws-profile>}"`
   - Update the code in `lib/mpc-network.ts` if fixes are needed
   - Deploy: `npx cdk deploy --context vpcId=<your-vpc-id> --profile "${AWS_PROFILE:-<your-aws-profile>}" --require-approval never`

**Integration Requirements**:
The MPC nodes need to integrate with:
- NEAR RPC: `http://<your-near-node-ip>:3030` (from AWSNodeRunner)
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
aws cloudformation describe-stacks --stack-name MpcStandaloneStack --profile "${AWS_PROFILE:-<your-aws-profile>}"

# List stopped tasks
aws ecs list-tasks --cluster mpc-nodes --desired-status STOPPED --profile "${AWS_PROFILE:-<your-aws-profile>}"

# Get task details (replace TASK_ID)
aws ecs describe-tasks --cluster mpc-nodes --tasks <task-id> --profile "${AWS_PROFILE:-<your-aws-profile>}"

# Check CloudWatch logs (if log group exists)
aws logs tail /aws/ecs/mpc-node-0 --follow --profile "${AWS_PROFILE:-<your-aws-profile>}"

# Delete stack and retry
aws cloudformation delete-stack --stack-name MpcStandaloneStack --profile "${AWS_PROFILE:-<your-aws-profile>}"
aws cloudformation wait stack-delete-complete --stack-name MpcStandaloneStack --profile "${AWS_PROFILE:-<your-aws-profile>}"

# Deploy
cd infra/aws-cdk
npm run build
npx cdk deploy --context vpcId=<your-vpc-id> --profile "${AWS_PROFILE:-<your-aws-profile>}" --require-approval never
```

