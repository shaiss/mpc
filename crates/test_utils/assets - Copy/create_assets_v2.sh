#!/bin/bash

if [ $# -ne 2 ]; then
    echo "Usage: $0 <input_json_file> <output_directory>"
    exit 1
fi

INPUT_FILE="$1"
OUTPUT_DIR="$2"

if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: Input file '$INPUT_FILE' does not exist"
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "Extracting data from '$INPUT_FILE' to '$OUTPUT_DIR'..."

# Extract P2P TLS public key
jq -j '.near_p2p_public_key' "$INPUT_FILE" > "$OUTPUT_DIR/near_p2p_public_key.pub"

# Extract app_compose.json (app_compose is a JSON string → decode once)
printf '%s' "$(jq -r --indent 4 '.tee_participant_info.Dstack.tcb_info.app_compose | fromjson' "$INPUT_FILE")" > "$OUTPUT_DIR/app_compose.json"

# Extract collateral (already JSON object, no fromjson)
jq -r '.tee_participant_info.Dstack.quote_collateral' "$INPUT_FILE" > "$OUTPUT_DIR/collateral.json"

# Extract quote
jq -c '.tee_participant_info.Dstack.tee_quote' "$INPUT_FILE" > "$OUTPUT_DIR/quote.json"

# Extract tcb_info.json (already object)
jq -r '.tee_participant_info.Dstack.tcb_info' "$INPUT_FILE" > "$OUTPUT_DIR/tcb_info.json"

# Extract launcher_image_compose.yaml (needs one fromjson on app_compose)
jq -j '.tee_participant_info.Dstack.tcb_info.app_compose | fromjson | .docker_compose_file' "$INPUT_FILE" > "$OUTPUT_DIR/launcher_image_compose.yaml"

# Extract expected digest
printf "%s" "$(grep 'DEFAULT_IMAGE_DIGEST' "$OUTPUT_DIR/launcher_image_compose.yaml" | grep -o '[a-f0-9]\{64\}')" > "$OUTPUT_DIR/mpc_image_digest.txt"

echo "Extraction complete. Files written to '$OUTPUT_DIR':"
ls -la "$OUTPUT_DIR"
