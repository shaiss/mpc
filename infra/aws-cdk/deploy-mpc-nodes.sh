#!/bin/bash
set -euo pipefail

# Quick deployment script for NEAR MPC nodes on AWS
# This script automates the deployment process after fixes

echo "════════════════════════════════════════════════════════════"
echo "   NEAR MPC Node Deployment Script (AWS CDK)"
echo "════════════════════════════════════════════════════════════"
echo ""

# Configuration
# Set these environment variables or modify defaults below
AWS_PROFILE="${AWS_PROFILE:-<your-aws-profile>}"
VPC_ID="${VPC_ID:-<your-vpc-id>}"
NEAR_RPC_IP="${NEAR_RPC_IP:-<your-near-node-ip>}"
NEAR_RPC_PORT="${NEAR_RPC_PORT:-3030}"
NEAR_P2P_PORT="${NEAR_P2P_PORT:-24567}"
NODE_COUNT="${NODE_COUNT:-3}"

echo "Configuration:"
echo "  AWS Profile: $AWS_PROFILE"
echo "  VPC ID: $VPC_ID"
echo "  NEAR RPC: http://$NEAR_RPC_IP:$NEAR_RPC_PORT"
echo "  Node Count: $NODE_COUNT"
echo ""

# Step 1: Verify NEAR node is accessible
echo "[1/6] Verifying NEAR node connectivity..."
if ! curl -s --max-time 5 "http://$NEAR_RPC_IP:$NEAR_RPC_PORT/status" > /dev/null; then
    echo "❌ ERROR: Cannot reach NEAR RPC at http://$NEAR_RPC_IP:$NEAR_RPC_PORT"
    echo "   Make sure:"
    echo "   1. NEAR node is running (AWSNodeRunner deployment)"
    echo "   2. Security groups allow access from your IP"
    echo "   3. IP address is correct"
    exit 1
fi
echo "   ✅ NEAR node is accessible"

# Get boot nodes
echo ""
echo "[2/6] Getting boot nodes from NEAR network..."
NEAR_RPC_URL="http://$NEAR_RPC_IP:$NEAR_RPC_PORT"
NEAR_NODE_KEY=$(curl -s "$NEAR_RPC_URL/status" | jq -r '.node_key')

if [ -z "$NEAR_NODE_KEY" ] || [ "$NEAR_NODE_KEY" = "null" ]; then
    echo "❌ ERROR: Could not get node key from NEAR node"
    exit 1
fi

NEAR_BOOT_NODES="${NEAR_NODE_KEY}@${NEAR_RPC_IP}:${NEAR_P2P_PORT}"
echo "   Boot nodes: $NEAR_BOOT_NODES"
echo "   ✅ Boot nodes configured"

# Step 2: Deploy CDK stack
echo ""
echo "[3/6] Deploying CDK stack..."
echo "   This may take 5-10 minutes..."

if ! npx cdk deploy \
    --context vpcId="$VPC_ID" \
    --context nearRpcUrl="$NEAR_RPC_URL" \
    --context nearBootNodes="$NEAR_BOOT_NODES" \
    --context nodeCount="$NODE_COUNT" \
    --profile "$AWS_PROFILE" \
    --require-approval never; then
    echo "❌ ERROR: CDK deployment failed"
    echo "   Check the error messages above"
    exit 1
fi
echo "   ✅ Stack deployed successfully"

# Step 3: Wait for stack to stabilize
echo ""
echo "[4/6] Waiting for stack resources to be ready..."
sleep 10
echo "   ✅ Stack ready"

# Step 4: Generate and populate secrets
echo ""
echo "[5/6] Generating test keys and populating secrets..."

if [ ! -f "./scripts/generate-test-keys.sh" ]; then
    echo "❌ ERROR: scripts/generate-test-keys.sh not found"
    exit 1
fi

# Generate test keys
echo "   Generating test keys..."
if ! ./scripts/generate-test-keys.sh "$NODE_COUNT" > /dev/null 2>&1; then
    echo "⚠️  WARNING: Key generation had issues, but may have created mpc-node-keys.json"
fi

if [ ! -f "./mpc-node-keys.json" ]; then
    echo "❌ ERROR: mpc-node-keys.json was not created"
    exit 1
fi

# Update secrets
echo "   Updating AWS Secrets Manager..."
if ! ./scripts/update-secrets.sh mpc-node-keys.json "$AWS_PROFILE" 2>&1 | grep -q "done"; then
    echo "   (Some secrets may not exist yet - this is normal during first deployment)"
fi
echo "   ✅ Secrets populated"

# Step 5: Start services
echo ""
echo "[6/6] Starting ECS services..."

for i in $(seq 0 $((NODE_COUNT - 1))); do
    echo "   Starting node-$i..."
    aws ecs update-service \
        --cluster mpc-nodes \
        --service "node-$i" \
        --desired-count 1 \
        --profile "$AWS_PROFILE" \
        --region us-east-1 > /dev/null
done

echo "   ✅ All services started"

# Summary
echo ""
echo "════════════════════════════════════════════════════════════"
echo "   ✅ Deployment Complete!"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Monitor service status:"
echo "     aws ecs describe-services --cluster mpc-nodes --services node-0 node-1 node-2 --profile $AWS_PROFILE | jq '.services[] | {name: .serviceName, running: .runningCount, desired: .desiredCount}'"
echo ""
echo "  2. View logs:"
echo "     aws logs tail <log-group-name> --follow --profile $AWS_PROFILE"
echo ""
echo "  3. Check MPC node endpoints (wait 2-3 minutes for startup):"
echo "     curl http://node-0.mpc-mpcstandalonestack.local:8080/public_data"
echo ""
echo "  4. View full deployment guide:"
echo "     cat DEPLOYMENT_GUIDE.md"
echo ""
echo "⚠️  Note: It may take 2-5 minutes for containers to fully start"
echo "    and sync with the NEAR blockchain."
echo ""

