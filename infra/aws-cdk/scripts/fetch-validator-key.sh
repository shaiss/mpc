#!/bin/bash
set -e

PROFILE="shai-sandbox-profile"
OUTPUT_FILE="node0-validator-key.json"

echo "🔍 Fetching node0 validator key from NEAR instance..."

# Get Instance ID
INSTANCE_ID=$(aws cloudformation describe-stacks \
    --stack-name near-localnet-infrastructure \
    --profile "$PROFILE" \
    --query "Stacks[0].Outputs[?OutputKey=='nearinstanceid'].OutputValue" \
    --output text)

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" == "None" ]; then
    echo "❌ Error: Could not find NEAR instance ID"
    exit 1
fi

echo "   Instance: $INSTANCE_ID"

# Fetch Key
CMD_ID=$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --parameters 'commands=["sudo -u ubuntu cat /home/ubuntu/.near/localnet/node0/validator_key.json"]' \
    --profile "$PROFILE" \
    --query "Command.CommandId" \
    --output text)

echo "   Waiting for SSM command..."
sleep 5

KEY_CONTENT=$(aws ssm get-command-invocation \
    --command-id "$CMD_ID" \
    --instance-id "$INSTANCE_ID" \
    --profile "$PROFILE" \
    --query "StandardOutputContent" \
    --output text)

if [[ "$KEY_CONTENT" != *"public_key"* ]]; then
    echo "❌ Error retrieving key: $KEY_CONTENT"
    exit 1
fi

echo "$KEY_CONTENT" > "$OUTPUT_FILE"
echo "✅ Key saved to $OUTPUT_FILE"

