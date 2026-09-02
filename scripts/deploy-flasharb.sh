#!/bin/bash
# Deploy FlashArbExecutor (piece 6) to a chain using its Aave V3 pool address
# from ignition/parameters/<chain>.json (kept in sync with conf/<chain>.json5's
# flashloan.pool by hand for now — there are only a few chains wired up).
#
# Usage: yarn deploy-flasharb <chain>

STAGE="deploy-flasharb"
CHAIN="$1"

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain>" >&2
    exit 1
fi

PARAMS="ignition/parameters/${CHAIN}.json"
if [ ! -f "$PARAMS" ]; then
    echo "Missing $PARAMS — create it with the chain's Aave V3 pool address:" >&2
    echo '  { "FlashArbModule": { "aavePool": "0x..." } }' >&2
    exit 1
fi

LOG="log/${CHAIN}/${STAGE}.log"
if [ ! -d "log/${CHAIN}" ]; then
    mkdir -p "log/${CHAIN}"
fi

{
	yarn hardhat compile
	yarn hardhat ignition deploy ignition/modules/FlashArbModule.ts --network $CHAIN --parameters $PARAMS

} 2>&1 | tee "$LOG"
