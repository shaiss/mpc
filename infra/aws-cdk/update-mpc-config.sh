#!/bin/bash
# Script to update MPC configuration with new NEAR instance details
# Run this after NEAR deployment completes

set -e

echo "🔄 Updating MPC configuration with new NEAR instance details..."

# Load new NEAR instance info
if [ ! -f /tmp/near-deployment-results.txt ]; then
    echo "❌ Error: NEAR deployment results not found"
    echo "   Run get-new-near-info.sh first"
    exit 1
fi

source /tmp/near-deployment-results.txt

echo "📋 New NEAR Instance:"
echo "   Instance ID: $INSTANCE_ID"
echo "   Private IP: $PRIVATE_IP"
echo "   Logical ID: $LOGICAL_ID"

# Update config.local.json
CONFIG_FILE="./config.local.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Error: $CONFIG_FILE not found"
    exit 1
fi

echo "📝 Updating $CONFIG_FILE..."

# Update rpcIp
jq --arg ip "$PRIVATE_IP" '.near.rpcIp = $ip' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

echo "✅ Updated rpcIp to $PRIVATE_IP"

# Update boot nodes if available
if [ -n "$BOOT_NODE_KEY" ] && [ "$BOOT_NODE_KEY" != "unavailable" ]; then
    BOOT_NODE="$BOOT_NODE_KEY@$PRIVATE_IP:24567"
    jq --arg boot "$BOOT_NODE" '.near.bootNodes = $boot' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    echo "✅ Updated bootNodes to $BOOT_NODE"
fi

echo ""
echo "✅ Configuration updated successfully!"
echo ""
echo "📋 Next steps:"
echo "   1. Review config.local.json"
echo "   2. Destroy old MPC stack"
echo "   3. Redeploy MPC nodes"
echo "   4. Set up chain state (accounts and contract)"

