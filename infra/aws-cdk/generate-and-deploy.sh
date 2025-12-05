#!/bin/bash
set -euo pipefail

# Comprehensive MPC Deployment Script
# This script handles the complete deployment lifecycle:
# 1. Load configuration from AWSNodeRunner deployment
# 2. Generate test MPC keys
# 3. Deploy CDK infrastructure  
# 4. Populate secrets
# 5. Verify deployment

echo "═══════════════════════════════════════════════════════════"
echo "   NEAR MPC Complete Deployment Script"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Load configuration
if [ -f ".env.local" ]; then
    echo "📄 Loading configuration from .env.local..."
    set -a
    source .env.local
    set +a
elif [ -f "config.local.json" ]; then
    echo "📄 Loading configuration from config.local.json..."
    AWS_PROFILE=$(jq -r '.aws.profile' config.local.json)
    VPC_ID=$(jq -r '.near.vpcId' config.local.json)
    NEAR_RPC_IP=$(jq -r '.near.rpcIp' config.local.json)
    NEAR_RPC_PORT=$(jq -r '.near.rpcPort' config.local.json)
    NEAR_P2P_PORT=$(jq -r '.near.p2pPort' config.local.json)
    NEAR_NETWORK_ID=$(jq -r '.near.networkId' config.local.json)
    NODE_COUNT=$(jq -r '.mpc.nodeCount' config.local.json)
    MPC_CONTRACT_ID=$(jq -r '.mpc.contractId' config.local.json)
    MPC_DOCKER_IMAGE_URI=$(jq -r '.mpc.dockerImage' config.local.json)
else
    echo "${RED}❌ ERROR: No configuration file found${NC}"
    echo "   Please create either .env.local or config.local.json"
    echo "   Use config.example.json as a template"
    exit 1
fi

# Set defaults
AWS_PROFILE=${AWS_PROFILE:-default}
NODE_COUNT=${NODE_COUNT:-3}
NEAR_NETWORK_ID=${NEAR_NETWORK_ID:-localnet}
MPC_CONTRACT_ID=${MPC_CONTRACT_ID:-v1.signer.node0}

echo "Configuration:"
echo "  AWS Profile: $AWS_PROFILE"
echo "  VPC ID: $VPC_ID"
echo "  NEAR RPC: http://$NEAR_RPC_IP:$NEAR_RPC_PORT"
echo "  Network: $NEAR_NETWORK_ID"
echo "  Nodes: $NODE_COUNT"
echo ""

# Step 1: Get NEAR node key for boot nodes
echo "[1/5] Getting NEAR node boot nodes..."
INSTANCE_ID=$(aws cloudformation describe-stacks \
    --stack-name near-localnet-infrastructure \
    --query 'Stacks[0].Outputs[?OutputKey==`nearinstanceid`].OutputValue' \
    --output text \
    --profile "$AWS_PROFILE" 2>/dev/null || echo "")

if [ -z "$INSTANCE_ID" ]; then
    echo "${YELLOW}⚠️  WARNING: Could not find NEAR instance ID from CloudFormation${NC}"
    echo "   Continuing without boot nodes (may need to configure manually)"
    NEAR_BOOT_NODES=""
else
    echo "   Getting node key from instance $INSTANCE_ID..."
    COMMAND_ID=$(aws ssm send-command \
        --instance-ids "$INSTANCE_ID" \
        --document-name "AWS-RunShellScript" \
        --parameters 'commands=["curl -s http://localhost:3030/status | jq -r .node_key"]' \
        --profile "$AWS_PROFILE" \
        --query 'Command.CommandId' \
        --output text)
    
    sleep 3
    
    NODE_KEY=$(aws ssm get-command-invocation \
        --command-id "$COMMAND_ID" \
        --instance-id "$INSTANCE_ID" \
        --profile "$AWS_PROFILE" \
        --query 'StandardOutputContent' \
        --output text | tr -d '\n')
    
    if [ -n "$NODE_KEY" ] && [ "$NODE_KEY" != "null" ]; then
        NEAR_BOOT_NODES="${NODE_KEY}@${NEAR_RPC_IP}:${NEAR_P2P_PORT}"
        echo "   ${GREEN}✅ Boot nodes: $NEAR_BOOT_NODES${NC}"
    else
        echo "   ${YELLOW}⚠️  Could not retrieve node key${NC}"
        NEAR_BOOT_NODES=""
    fi
fi

# Step 2: Generate MPC keys
echo ""
echo "[2/5] Generating MPC test keys..."
if [ -f "./scripts/generate-test-keys.sh" ]; then
    chmod +x ./scripts/generate-test-keys.sh
    ./scripts/generate-test-keys.sh "$NODE_COUNT"
    echo "   ${GREEN}✅ Keys generated${NC}"
else
    echo "${RED}❌ ERROR: generate-test-keys.sh not found${NC}"
    exit 1
fi

# Step 3: Build CDK
echo ""
echo "[3/5] Building CDK project..."
npm run build
echo "   ${GREEN}✅ Build complete${NC}"

# Step 4: Deploy CDK stack
echo ""
echo "[4/5] Deploying CDK stack..."
echo "   This may take 5-10 minutes..."

NEAR_RPC_URL="http://${NEAR_RPC_IP}:${NEAR_RPC_PORT}"

npx cdk deploy \
    --profile "$AWS_PROFILE" \
    --context vpcId="$VPC_ID" \
    --context nearRpcUrl="$NEAR_RPC_URL" \
    --context nearNetworkId="$NEAR_NETWORK_ID" \
    --context nearBootNodes="$NEAR_BOOT_NODES" \
    --context mpcContractId="$MPC_CONTRACT_ID" \
    --context nodeCount="$NODE_COUNT" \
    ${MPC_DOCKER_IMAGE_URI:+--context dockerImageUri="$MPC_DOCKER_IMAGE_URI"} \
    --require-approval never

if [ $? -eq 0 ]; then
    echo "   ${GREEN}✅ Stack deployed${NC}"
else
    echo "${RED}❌ ERROR: Stack deployment failed${NC}"
    exit 1
fi

# Step 5: Populate secrets
echo ""
echo "[5/5] Populating AWS Secrets Manager..."
if [ -f "./scripts/update-secrets.sh" ] && [ -f "./mpc-node-keys.json" ]; then
    chmod +x ./scripts/update-secrets.sh
    ./scripts/update-secrets.sh ./mpc-node-keys.json "$AWS_PROFILE"
    echo "   ${GREEN}✅ Secrets populated${NC}"
else
    echo "${YELLOW}⚠️  Could not populate secrets automatically${NC}"
fi

# Summary
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "   ${GREEN}✅ Deployment Complete!${NC}"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "MPC services are starting. Monitor with:"
echo "  aws ecs describe-services --cluster mpc-nodes --services node-0 node-1 node-2 \\"
echo "    --profile $AWS_PROFILE | jq '.services[] | {name: .serviceName, running: .runningCount}'"
echo ""
echo "View logs:"
echo "  aws logs tail MpcStandaloneStack-MpcNetworkNode0TaskDefinitionNode0ContainerLogGroup* \\"
echo "    --follow --profile $AWS_PROFILE"
echo ""
echo "${YELLOW}⚠️  Note: Tasks may take 2-5 minutes to start and become healthy${NC}"
echo ""

