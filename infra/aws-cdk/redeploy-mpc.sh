#!/bin/bash
# Script to redeploy MPC nodes with updated configuration
# Run this after updating config.local.json

set -e

PROFILE="shai-sandbox-profile"

echo "🔄 Redeploying MPC nodes..."

# Step 1: Destroy old MPC stack
echo "🗑️  Destroying old MPC stack..."
npx cdk destroy --profile "$PROFILE" --force 2>&1 | tee /tmp/mpc-destroy.log

echo "✅ Old stack destroyed"

# Step 2: Clean up old deployment artifacts
echo "🧹 Cleaning up..."
rm -f mpc-node-keys.json 2>/dev/null || true

# Step 3: Run generate-and-deploy script
echo "🚀 Deploying new MPC stack..."
./generate-and-deploy.sh 2>&1 | tee /tmp/mpc-deploy.log

echo ""
echo "=========================================="
echo "✅ MPC Redeployment Complete!"
echo "=========================================="
echo ""
echo "📋 Next steps:"
echo "   1. Set up NEAR chain state (accounts and contract)"
echo "   2. Verify MPC nodes can sync with NEAR"

