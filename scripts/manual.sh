#!/bin/sh
# Run the full data pipeline for one chain, teeing output to <chain>.log.
# Usage: yarn manual <chain>
set -e

CHAIN="$1"
if [ -z "$CHAIN" ]; then
    echo "Usage: yarn manual <chain>" >&2
    exit 1
fi

LOG="${CHAIN}.log"

{
    echo "=== scan ==="       ; yarn scan "$CHAIN"
    echo "=== reserves ==="   ; yarn reserves "$CHAIN"
    echo "=== triangles ==="  ; yarn triangles "$CHAIN"
    echo "=== evaluate ==="   ; yarn evaluate "$CHAIN" --limit 20 --verbose
} 2>&1 | tee "$LOG"
