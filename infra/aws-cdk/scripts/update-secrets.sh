#!/bin/bash
set -euo pipefail

# Script to update AWS Secrets Manager with MPC node keys
# Usage: ./update-secrets.sh [keys-file] [aws-profile]

# Load environment variables from .env.local if it exists
if [ -f .env.local ]; then
    set -a
    source .env.local
    set +a
fi

KEYS_FILE="${1:-./mpc-node-keys.json}"
AWS_PROFILE="${2:-${AWS_PROFILE:-<your-aws-profile>}}"

if [ ! -f "$KEYS_FILE" ]; then
    echo "ERROR: Keys file not found: $KEYS_FILE"
    echo "Usage: $0 [keys-file] [aws-profile]"
    exit 1
fi

echo "=== Updating AWS Secrets Manager ==="
echo "Keys file: $KEYS_FILE"
echo "AWS profile: $AWS_PROFILE"
echo ""

# Read number of nodes from JSON
NODE_COUNT=$(jq 'keys | length' "$KEYS_FILE")

echo "Updating secrets for $NODE_COUNT nodes..."
echo ""

for i in $(seq 0 $((NODE_COUNT - 1))); do
    echo "Updating secrets for node-$i..."
    
    # Extract keys from JSON
    ACCOUNT_SK=$(jq -r ".\"node-$i\".MPC_ACCOUNT_SK" "$KEYS_FILE")
    P2P_KEY=$(jq -r ".\"node-$i\".MPC_P2P_PRIVATE_KEY" "$KEYS_FILE")
    SECRET_STORE_KEY=$(jq -r ".\"node-$i\".MPC_SECRET_STORE_KEY" "$KEYS_FILE")
    
    # Update MPC_ACCOUNT_SK
    echo "  - Updating mpc-node-$i-mpc_account_sk..."
    aws secretsmanager put-secret-value \
        --secret-id "mpc-node-$i-mpc_account_sk" \
        --secret-string "{\"key\":\"$ACCOUNT_SK\"}" \
        --profile "$AWS_PROFILE" \
        --region us-east-1 || echo "    (Secret may not exist yet - will be created on stack deployment)"
    
    # Update MPC_P2P_PRIVATE_KEY
    echo "  - Updating mpc-node-$i-mpc_p2p_private_key..."
    aws secretsmanager put-secret-value \
        --secret-id "mpc-node-$i-mpc_p2p_private_key" \
        --secret-string "{\"key\":\"$P2P_KEY\"}" \
        --profile "$AWS_PROFILE" \
        --region us-east-1 || echo "    (Secret may not exist yet - will be created on stack deployment)"
    
    # Update MPC_SECRET_STORE_KEY
    echo "  - Updating mpc-node-$i-mpc_secret_store_key..."
    aws secretsmanager put-secret-value \
        --secret-id "mpc-node-$i-mpc_secret_store_key" \
        --secret-string "{\"key\":\"$SECRET_STORE_KEY\"}" \
        --profile "$AWS_PROFILE" \
        --region us-east-1 || echo "    (Secret may not exist yet - will be created on stack deployment)"
    
    echo "  ✅ Done"
    echo ""
done

echo "✅ All secrets updated successfully!"
echo ""
echo "You can now deploy the CDK stack:"
echo "  export VPC_ID=<your-vpc-id>"
echo "  npx cdk deploy --context vpcId=\$VPC_ID --profile $AWS_PROFILE --require-approval never"

