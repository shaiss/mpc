#!/bin/bash
set -euo pipefail

# Script to generate proper MPC keys for localnet environment
# Uses the Rust generate_keys crate to create valid NEAR ed25519 keys
# Based on: infra/scripts/generate_keys/src/main.rs

echo "=== MPC Node Test Key Generator ==="
echo "This script generates proper ed25519 keys using near-crypto"
echo ""

# Number of nodes
NODE_COUNT=${1:-3}

# Path to the Rust key generator
KEY_GEN_PATH="$(cd "$(dirname "$0")/../../scripts/generate_keys" && pwd)"

echo "Building key generator (this may take a moment on first run)..."
cd "$KEY_GEN_PATH"
if ! cargo build --release --quiet 2>/dev/null; then
    echo "⚠️  Warning: Release build failed, trying debug build..."
    cargo build --quiet
    KEY_GEN_BIN="$KEY_GEN_PATH/target/debug/generate_keys"
else
    KEY_GEN_BIN="$KEY_GEN_PATH/target/release/generate_keys"
fi

echo "✅ Key generator ready"
echo ""
echo "Generating keys for $NODE_COUNT nodes..."
echo ""

# Go back to aws-cdk directory
cd - > /dev/null

# Output file
OUTPUT_FILE="./mpc-node-keys.json"

echo "{" > "$OUTPUT_FILE"

for i in $(seq 0 $((NODE_COUNT - 1))); do
    echo "Generating keys for node-$i..."
    
    ACCOUNT_ID="mpc-node-$i.node0"
    
    # Run the Rust key generator to get proper NEAR ed25519 keys
    KEY_OUTPUT=$($KEY_GEN_BIN)
    
    # Parse the output (format: "p2p public key sign_pk: ...\np2p secret key sign_sk: ...\n...")
    P2P_PK=$(echo "$KEY_OUTPUT" | grep "p2p public key sign_pk:" | cut -d ' ' -f 5)
    P2P_KEY=$(echo "$KEY_OUTPUT" | grep "p2p secret key sign_sk:" | cut -d ' ' -f 5)
    ACCOUNT_SK=$(echo "$KEY_OUTPUT" | grep "near account secret key:" | cut -d ' ' -f 5)
    ACCOUNT_PK=$(echo "$KEY_OUTPUT" | grep "near account public key:" | cut -d ' ' -f 5)
    SECRET_STORE_KEY=$(echo "$KEY_OUTPUT" | grep "near local encryption key:" | cut -d ' ' -f 5)
    
    # Add to JSON output
    if [ $i -gt 0 ]; then
        echo "," >> "$OUTPUT_FILE"
    fi
    
    cat >> "$OUTPUT_FILE" <<EOF
  "node-$i": {
    "MPC_ACCOUNT_ID": "$ACCOUNT_ID",
    "MPC_ACCOUNT_SK": "$ACCOUNT_SK",
    "MPC_ACCOUNT_PK": "$ACCOUNT_PK",
    "MPC_P2P_PRIVATE_KEY": "$P2P_KEY",
    "MPC_P2P_PUBLIC_KEY": "$P2P_PK",
    "MPC_SECRET_STORE_KEY": "$SECRET_STORE_KEY"
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

