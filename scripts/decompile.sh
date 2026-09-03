#!/bin/bash

STAGE="decompile"
CHAIN="$1"
CONTRACT="$2"

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain> <contract>" >&2
    exit 1
elif [ -z "$CONTRACT" ]; then
    echo "Usage: yarn $STAGE <chain> <contract>" >&2
    exit 1
fi

LOG="log/${CHAIN}/${STAGE}-${CONTRACT}.log"
if [ ! -d "log/${CHAIN}" ]; then
    mkdir -p "log/${CHAIN}"
fi

export RPCURL=$(node --experimental-strip-types --disable-warning=ExperimentalWarning source/util/resolvehost.ts $CHAIN)

{
	sevm sol --rpc-url $RPCURL ${CONTRACT}
} 2>&1 | tee "$LOG"