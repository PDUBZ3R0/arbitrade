#!/bin/bash

STAGE="deploy-contract"
CHAIN="$1"

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain> [--redeploy]" >&2
    exit 1
fi

REDEPLOY=0
shift 2>/dev/null
for arg in "$@"; do
    case "$arg" in
        --redeploy) REDEPLOY=1 ;;
    esac
done

export HARDHAT_IGNITION_CONFIRM_DEPLOYMENT=false

CONF="conf/${CHAIN}.json5"
FUTURE_ID="Yo3Module#YoBatches3"
# Ignition's default deployment id is chain-<chainId>. Read the id from the
# chain config rather than hardcoding a map that would drift. Try JSON5 first,
# fall back to the first `id:` in the file (the chain block leads it).
#
# A failure here must NOT block a plain deploy — only --redeploy needs the id.
CHAIN_ID=""
if [ -f "$CONF" ]; then
    CHAIN_ID=$(node --input-type=module -e "
import JSON5 from 'json5';
import { readFileSync } from 'node:fs';
const c = JSON5.parse(readFileSync('${CONF}', 'utf8'));
if (c?.chain?.id) process.stdout.write(String(c.chain.id));
" 2>/dev/null)
    if [ -z "$CHAIN_ID" ]; then
        CHAIN_ID=$(grep -m1 -oE '^[[:space:]]*id:[[:space:]]*[0-9]+' "$CONF" 2>/dev/null | grep -oE '[0-9]+')
    fi
fi
DEPLOYMENT_ID="chain-${CHAIN_ID}"

LOG="log/${CHAIN}/${STAGE}.log"
if [ ! -d "log/${CHAIN}" ]; then
    mkdir -p "log/${CHAIN}"
fi

{

	if [ "$REDEPLOY" = "1" ]; then
		echo "--redeploy: wiping ${FUTURE_ID} from ${DEPLOYMENT_ID} so new bytecode actually deploys"
		yarn hardhat ignition wipe "$DEPLOYMENT_ID" "$FUTURE_ID" || exit 1
	fi

	yarn hardhat compile || exit 1
	yarn hardhat ignition deploy ignition/modules/Yo3Module.ts --network $CHAIN || exit 1
	echo ""
	echo "YoBatches3 deployed. Set chain.contract in conf/${CHAIN}.json5 to the Yo3Module#YoBatches3 address above."
	echo "(It keeps every YoBatches2 function, so nothing else changes; reserves switches to the packed reads by itself.)"

} 2>&1 | tee "$LOG"
exit ${PIPESTATUS[0]}