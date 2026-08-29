#!/bin/sh
# Run the full data pipeline for one chain, teeing output to <chain>.log.
# Usage: yarn manual <chain>
set -e

ROOT="$1"
shift

STAGE="$1"
shift

CHAIN="$1"
shift

echo "ROOT: $ROOT"
echo "STAGE:" $STAGE
echo "CHAIN": $CHAIN

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn manual <chain>" >&2 $@
    exit 1
fi

LOG="log/${CHAIN}/${STAGE}.log"
if [ ! -d "log/${CHAIN}" ]; then
    mkdir -p "log/${CHAIN}"
fi

{
    echo "=== $STAGE ($CHAIN) ==="
    node --experimental-strip-types --disable-warning=ExperimentalWarning $ROOT/$STAGE.ts "$CHAIN"
    echo

} 2>&1 | tee "$LOG"
