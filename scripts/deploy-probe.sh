#!/bin/bash
# Deploy TokenProbe to a chain, reusing the Aave V3 pool address already in
# ignition/parameters/<chain>.json under FlashArbModule (single source of truth).
#
# Usage: yarn deploy-probe <chain>
# Then add the printed address as  probe: "0x..."  in the chain block of conf/<chain>.json5.

STAGE="deploy-probe"
CHAIN="$1"

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain>" >&2
    exit 1
fi

PARAMS="ignition/parameters/${CHAIN}.json"
if [ ! -f "$PARAMS" ]; then
    echo "Missing $PARAMS — it needs the chain's Aave V3 pool:" >&2
    echo '  { "FlashArbModule": { "aavePool": "0x..." } }' >&2
    exit 1
fi

POOL=$(node -e "const p=require('./$PARAMS'); const a=p.FlashArbModule && p.FlashArbModule.aavePool; if(!a){process.exit(1)} console.log(a)")
if [ -z "$POOL" ]; then
    echo "No FlashArbModule.aavePool in $PARAMS" >&2
    exit 1
fi

# Same as deploy-contract/deploy-flasharb: no interactive "Confirm deploy?" prompt,
# which would otherwise stall `yarn deploy-all` halfway through.
export HARDHAT_IGNITION_CONFIRM_DEPLOYMENT=false
mkdir -p "log/${CHAIN}"
LOG="log/${CHAIN}/${STAGE}.log"
TMP_PARAMS=$(mktemp --suffix=.json)
trap 'rm -f "$TMP_PARAMS"' EXIT
echo "{ \"TokenProbeModule\": { \"aavePool\": \"$POOL\" } }" > "$TMP_PARAMS"

{
	echo "Aave pool (from $PARAMS): $POOL"
	yarn hardhat compile || exit 1
	yarn hardhat ignition deploy ignition/modules/TokenProbeModule.ts --network $CHAIN --parameters $TMP_PARAMS || exit 1
	echo ""
	echo "Next: add the TokenProbeModule#TokenProbe address above as  probe: \"0x...\"  in the chain block of conf/${CHAIN}.json5"
} 2>&1 | tee "$LOG"
exit ${PIPESTATUS[0]}
