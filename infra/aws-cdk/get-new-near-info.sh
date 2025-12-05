#!/bin/bash
# Script to retrieve new NEAR instance information after deployment
# Run this after the new NEAR instance is created

set -e

PROFILE="shai-sandbox-profile"
STACK_NAME="near-localnet-infrastructure"

echo "🔍 Retrieving new NEAR instance information..."

# Get instance ID
INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='nearinstanceid'].OutputValue" \
  --output text)

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" == "None" ]; then
  echo "❌ Error: Could not retrieve instance ID"
  exit 1
fi

echo "✅ Instance ID: $INSTANCE_ID"

# Get private IP
PRIVATE_IP=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='nearinstanceprivateip'].OutputValue" \
  --output text)

echo "✅ Private IP: $PRIVATE_IP"

# Wait for instance to be running and NEAR to be ready
echo "⏳ Waiting for instance to be ready..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --profile "$PROFILE"
echo "✅ Instance is running"

# Wait for NEAR to be ready (check RPC endpoint)
echo "⏳ Waiting for NEAR RPC to be ready..."
for i in {1..60}; do
  if aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --parameters 'commands=["curl -s http://localhost:3030/status > /dev/null 2>&1 && echo ready"]' \
    --profile "$PROFILE" \
    --query "Command.CommandId" \
    --output text > /tmp/ssm-cmd-id.txt 2>/dev/null; then
    
    CMD_ID=$(cat /tmp/ssm-cmd-id.txt)
    sleep 5
    RESULT=$(aws ssm get-command-invocation \
      --command-id "$CMD_ID" \
      --instance-id "$INSTANCE_ID" \
      --profile "$PROFILE" \
      --query "StandardOutputContent" \
      --output text 2>/dev/null || echo "")
    
    if [[ "$RESULT" == *"ready"* ]]; then
      echo "✅ NEAR RPC is ready"
      break
    fi
  fi
  sleep 10
done

# Get boot node key
echo "🔑 Retrieving boot node key..."
BOOT_NODE_KEY=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["curl -s http://localhost:3030/status | jq -r .node_key"]' \
  --profile "$PROFILE" \
  --query "Command.CommandId" \
  --output text)

sleep 5
BOOT_NODE_KEY_VALUE=$(aws ssm get-command-invocation \
  --command-id "$BOOT_NODE_KEY" \
  --instance-id "$INSTANCE_ID" \
  --profile "$PROFILE" \
  --query "StandardOutputContent" \
  --output text | tr -d '\n' | xargs)

if [ -z "$BOOT_NODE_KEY_VALUE" ] || [ "$BOOT_NODE_KEY_VALUE" == "None" ]; then
  echo "⚠️  Warning: Could not retrieve boot node key"
  BOOT_NODE_KEY_VALUE=""
else
  echo "✅ Boot Node Key: $BOOT_NODE_KEY_VALUE"
fi

# Output results
echo ""
echo "📋 New NEAR Instance Information:"
echo "=================================="
echo "Instance ID: $INSTANCE_ID"
echo "Private IP: $PRIVATE_IP"
echo "RPC URL: http://$PRIVATE_IP:3030"
echo "Boot Node Key: $BOOT_NODE_KEY_VALUE"
echo ""
echo "💡 Update config.local.json with:"
echo "   \"rpcIp\": \"$PRIVATE_IP\""
if [ -n "$BOOT_NODE_KEY_VALUE" ]; then
  echo "   \"bootNodes\": \"$BOOT_NODE_KEY_VALUE@$PRIVATE_IP:24567\""
fi

