#!/bin/bash
set -euo pipefail

# Redeploy MPC nodes with updated configuration.
# Uses config.local.json as the source of truth.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PROFILE="$(jq -r '.aws.profile // "shai-sandbox-profile"' config.local.json)"
NODE_COUNT="$(jq -r '.mpc.nodeCount // 3' config.local.json)"

echo "🔄 Redeploying MPC nodes..."
echo "  Profile: $PROFILE"
echo "  Nodes:   $NODE_COUNT"
echo ""

echo "🧹 Cleaning up local key artifacts..."
rm -f mpc-node-keys.json 2>/dev/null || true

echo "🔐 Generating fresh test keys..."
chmod +x ./scripts/generate-test-keys.sh ./scripts/update-secrets.sh
./scripts/generate-test-keys.sh "$NODE_COUNT"

echo "📦 Building CDK project..."
npm run build

echo "🗑️  Destroying old MPC stack (if present)..."
npx cdk destroy MpcStandaloneStack --profile "$PROFILE" --force || true

echo "🚀 Deploying MPC stack..."
npx cdk deploy MpcStandaloneStack --profile "$PROFILE" --require-approval never

echo "🔑 Populating Secrets Manager with generated keys..."
./scripts/update-secrets.sh ./mpc-node-keys.json "$PROFILE"

echo ""
echo "=========================================="
echo "✅ MPC Redeployment Complete"
echo "=========================================="
echo ""
echo "Next:"
echo "  - Watch MPC logs on the instances (SSM → docker logs mpc-node)"
echo "  - Verify embedded NEAR sync: curl http://localhost:3030/status"

