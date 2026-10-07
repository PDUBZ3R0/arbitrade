#!/bin/bash
# Deploy LiquidationExecutor (contracts/LiquidationExecutor.sol) to a chain.
# No constructor arguments: the deployer is the owner, and the Aave pool and
# flash lender are passed per call.
#
# Usage: yarn deploy-liquidator <chain> [--redeploy]
#
#   --redeploy   Wipe the existing LiquidationExecutor record first, forcing a
#                fresh deployment at a new address. REQUIRED after any change to
#                contracts/LiquidationExecutor.sol or contracts/HopEngine.sol —
#                Ignition keys deployments on the future id, not the bytecode,
#                and otherwise reports "Nothing new to deploy" and leaves the
#                old contract in place (see deploy-flasharb.sh for the long
#                version of why that is dangerous).
#
# Afterwards: yarn contract-update <chain>   (writes `liquidator:` into the config)

STAGE="deploy-liquidator"
CHAIN="$1"
REDEPLOY=0
shift 2>/dev/null
for arg in "$@"; do
    case "$arg" in
        --redeploy) REDEPLOY=1 ;;
    esac
done

if [ -z "$CHAIN" ] || [ "${CHAIN#--}" != "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain> [--redeploy]" >&2
    echo "" >&2
    echo "  --redeploy   Wipe the existing LiquidationExecutor record and deploy fresh." >&2
    echo "               REQUIRED after any change to contracts/LiquidationExecutor.sol —" >&2
    echo "               Ignition will otherwise report success and leave the old" >&2
    echo "               bytecode in place." >&2
    exit 1
fi

CONF="conf/${CHAIN}.json5"
FUTURE_ID="LiquidationModule#LiquidationExecutor"

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

if [ "$REDEPLOY" = "1" ] && [ -z "$CHAIN_ID" ]; then
    echo "--redeploy needs the chain id, and it could not be read from $CONF." >&2
    echo "Wipe the future by hand, then deploy:" >&2
    echo "  yarn hardhat ignition wipe chain-<chainId> '$FUTURE_ID'" >&2
    echo "  yarn $STAGE $CHAIN" >&2
    exit 1
fi
export HARDHAT_IGNITION_CONFIRM_DEPLOYMENT=false
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
	yarn hardhat ignition deploy ignition/modules/LiquidationModule.ts --network $CHAIN || exit 1

} 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}

# Catch the silent-no-op case even when the operator forgot --redeploy. Checked
# against the log we just wrote, so it also covers a deploy run by hand.
if [ "$REDEPLOY" != "1" ] && grep -q "Nothing new to deploy" "$LOG"; then
    echo "" >&2
    echo "  [!] Ignition deployed NOTHING — it already has a record for ${FUTURE_ID}." >&2
    echo "      The address above is the PREVIOUSLY deployed contract. If you changed" >&2
    echo "      contracts/LiquidationExecutor.sol, that edit is NOT on-chain, and calls" >&2
    echo "      against the new ABI will revert with empty data on every candidate." >&2
    echo "" >&2
    echo "      To deploy the new bytecode:" >&2
    if [ -n "$CHAIN_ID" ]; then
        echo "        yarn $STAGE $CHAIN --redeploy" >&2
    else
        echo "        yarn hardhat ignition wipe chain-<chainId> '$FUTURE_ID'" >&2
        echo "        yarn $STAGE $CHAIN" >&2
    fi
    echo "" >&2
    echo "      Then run  yarn contract-update ${CHAIN}  to point liquidator: at the new address." >&2
fi

exit $STATUS
