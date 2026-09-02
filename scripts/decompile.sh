#!/bin/bash

STAGE="panoramix"
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
node --experimental-strip-types --disable-warning=ExperimentalWarning source/util/resolvehost.ts $CHAIN
export RPCURL=$(node --experimental-strip-types --disable-warning=ExperimentalWarning source/util/resolvehost.ts $CHAIN)

{
	echo "RPC URL: $RPCURL"
	WEB3_PROVIDER_URI=$RPCURL \
	PYTHONINTMAXSTRDIGITS=0 \
	panoramix ${CONTRACT}
} 2>&1 | tee "$LOG"