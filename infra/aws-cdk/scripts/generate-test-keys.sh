#!/bin/bash
set -euo pipefail

# Script to generate test keys for MPC nodes in localnet environment
# This generates placeholder keys that can be used for local testing
# 
# For production (testnet/mainnet), keys should be generated securely
# and managed according to security best practices.

echo "=== MPC Node Test Key Generator ==="
echo "This script generates test keys for localnet MPC nodes"
echo ""

# Check if near CLI is installed
if ! command -v near &> /dev/null; then
    echo "ERROR: NEAR CLI is not installed"
    echo "Install from: https://docs.near.org/tools/near-cli"
    exit 1
fi

# Number of nodes
NODE_COUNT=${1:-3}

echo "Generating keys for $NODE_COUNT nodes..."
echo ""

# Create temp directory for keys
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Output file
OUTPUT_FILE="./mpc-node-keys.json"

echo "{" > "$OUTPUT_FILE"

for i in $(seq 0 $((NODE_COUNT - 1))); do
    echo "Generating keys for node-$i..."
    
    # Generate a key pair using NEAR CLI
    # For localnet testing, we create a simple implicit account
    ACCOUNT_ID="mpc-node-$i.node0"
    
    # Generate account key (ed25519)
    near account create-account fund-myself \
        "$ACCOUNT_ID" \
        '0.1 NEAR' \
        autogenerate-new-keypair \
        save-to-legacy-keychain \
        sign-as test.near \
        network-config custom \
        --rpc-url http://127.0.0.1:3030 \
        --send || true
    
    # For testing, we'll use a simple format
    # In production, these would be proper ed25519 keys from NEAR accounts
    
    # Generate test P2P key (in practice, MPC node generates this)
    P2P_KEY="ed25519:$(openssl rand -hex 32)"
    
    # Get account key from keychain or generate a test key
    ACCOUNT_SK="ed25519:$(openssl rand -hex 32)"
    
    # Add to JSON output
    if [ $i -gt 0 ]; then
        echo "," >> "$OUTPUT_FILE"
    fi
    
    cat >> "$OUTPUT_FILE" <<EOF
  "node-$i": {
    "MPC_ACCOUNT_ID": "$ACCOUNT_ID",
    "MPC_ACCOUNT_SK": "$ACCOUNT_SK",
    "MPC_P2P_PRIVATE_KEY": "$P2P_KEY",
    "MPC_SECRET_STORE_KEY": "$(openssl rand -hex 16)"
  }
EOF
done

echo "" >> "$OUTPUT_FILE"
echo "}" >> "$OUTPUT_FILE"

echo ""
echo "✅ Test keys generated and saved to: $OUTPUT_FILE"
echo ""
echo "⚠️  IMPORTANT: These are TEST keys for localnet only!"
echo "   For production, generate keys securely and never commit them to git."
echo ""
echo "Next steps:"
echo "1. Review the generated keys in $OUTPUT_FILE"
echo "2. Use update-secrets.sh to populate AWS Secrets Manager"
echo "3. Deploy the CDK stack"

