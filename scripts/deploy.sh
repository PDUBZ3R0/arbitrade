#!/bin/bash

STAGE="deploy-contract"
CHAIN="$1"

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain>" >&2
    exit 1
fi

LOG="log/${CHAIN}/${STAGE}.log"
if [ ! -d "log/${CHAIN}" ]; then
    mkdir -p "log/${CHAIN}"
fi

{
	yarn hardhat compile
	yarn hardhat ignition deploy ignition/modules/YoModule.ts --network $CHAIN
	echo ""
	echo "YoBatches2 deployed. Set chain.contract in conf/${CHAIN}.json5 to the Yo2Module#YoBatches2 address above."

} 2>&1 | tee "$LOG"