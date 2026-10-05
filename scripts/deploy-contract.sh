#!/bin/bash

STAGE="deploy-contract"
CHAIN="$1"

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain>" >&2
    exit 1
fi
export HARDHAT_IGNITION_CONFIRM_DEPLOYMENT=false
LOG="log/${CHAIN}/${STAGE}.log"
if [ ! -d "log/${CHAIN}" ]; then
    mkdir -p "log/${CHAIN}"
fi

{
	yarn hardhat compile || exit 1
	yarn hardhat ignition deploy ignition/modules/Yo3Module.ts --network $CHAIN || exit 1
	echo ""
	echo "YoBatches3 deployed. Set chain.contract in conf/${CHAIN}.json5 to the Yo3Module#YoBatches3 address above."
	echo "(It keeps every YoBatches2 function, so nothing else changes; reserves switches to the packed reads by itself.)"

} 2>&1 | tee "$LOG"
exit ${PIPESTATUS[0]}