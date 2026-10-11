#!/bin/bash
# Deploy the project's contracts to a chain — only what needs it.
#
# Usage: bash scripts/deploy.sh <flasharb|liquidator|contract|probe|all> <chain> [--force] [--check]
#   yarn deploy <what> <chain>, or the shortcuts in package.json:
#   yarn deploy-flasharb / deploy-liquidator / deploy-contract / deploy-probe / deploy-all <chain>
#
#   all       every contract in turn (YoBatches3, FlashArbExecutor, TokenProbe,
#             LiquidationExecutor); current ones are left alone; stops at the
#             first failure
#
#   --check   report whether the on-chain code is current; change nothing
#   --force   deploy a fresh copy even if the code is current (alias: --redeploy)
#             — e.g. after changing a constructor argument, which the check
#             deliberately ignores
#
# What it does:
#   1. hardhat compile
#   2. scripts/deploy-check.ts: is the code at chain.<field> (or at Ignition's
#      recorded address) the code in contracts/?  Immutables and the metadata
#      hash are ignored, so a comment-only edit does not trigger a redeploy.
#        current  -> nothing to do (unless --force)
#        missing  -> deploy
#        outdated -> wipe Ignition's record for this one contract, deploy fresh
#        pending  -> refuse: the deployer has a transaction in flight, and a
#                    deploy now could duplicate one that is about to land
#        error    -> refuse: never deploy when we cannot tell
#   3. HyperEVM: big blocks on for the deploy, and OFF again on every exit path
#      (success, failure, Ctrl-C) — the deployer is the bot's key.
#   4. ignition deploy, then yarn contract-update to point the config at it,
#      then the check again: it must now say "current", or the run fails.
#
# Why the check instead of trusting Ignition: Ignition keys deployments on the
# future id, not the bytecode. After an edit to the .sol it prints "Nothing new
# to deploy" and leaves the OLD contract in place; the bot then calls the new
# ABI against old code and every candidate reverts with empty data.

WHAT="$1"; CHAIN="$2"
shift 2 2>/dev/null

if [ "$WHAT" = "all" ]; then
    [ -z "$CHAIN" ] && { echo "Usage: yarn deploy-all <chain> [--check]" >&2; exit 2; }
    for w in contract flasharb probe liquidator; do
        if ! bash "$0" "$w" "$CHAIN" "$@"; then
            case " $* " in *" --check "*) continue ;; esac   # --check: report every contract
            echo "" >&2
            echo "[deploy all] ${w} failed — stopping. See log/${CHAIN}/deploy-*.log; re-run when fixed." >&2
            exit 1
        fi
    done
    exit 0
fi
FORCE=0; CHECK_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --force|--redeploy) FORCE=1 ;;
        --check) CHECK_ONLY=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

case "$WHAT" in
    flasharb)   CONTRACT=FlashArbExecutor;    FIELD=executor;   MODULE=FlashArbModule;    STAGE=deploy-flasharb ;;
    liquidator) CONTRACT=LiquidationExecutor; FIELD=liquidator; MODULE=LiquidationModule; STAGE=deploy-liquidator ;;
    contract)   CONTRACT=YoBatches3;          FIELD=contract;   MODULE=Yo3Module;         STAGE=deploy-contract ;;
    probe)      CONTRACT=TokenProbe;          FIELD=probe;      MODULE=TokenProbeModule;  STAGE=deploy-probe ;;
    *) echo "Usage: yarn deploy <flasharb|liquidator|contract|probe|all> <chain> [--force] [--check]" >&2; exit 2 ;;
esac
FUTURE="${MODULE}#${CONTRACT}"
if [ -z "$CHAIN" ] || [ "${CHAIN#--}" != "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain> [--force] [--check]" >&2; exit 2
fi

# Constructor parameters. FlashArbExecutor and TokenProbe take the chain's Aave
# pool from ignition/parameters/<chain>.json (address(0) where there is none).
PARAMS_ARG=""
PARAMS="ignition/parameters/${CHAIN}.json"
TMP_PARAMS=""
if [ "$WHAT" = "flasharb" ] || [ "$WHAT" = "probe" ]; then
    if [ ! -f "$PARAMS" ]; then
        echo "Missing $PARAMS — it needs the chain's Aave V3 pool (0x000…0 if none):" >&2
        echo '  { "FlashArbModule": { "aavePool": "0x..." } }' >&2
        exit 1
    fi
    if [ "$WHAT" = "flasharb" ]; then
        PARAMS_ARG="--parameters $PARAMS"
    else
        POOL=$(node -e "const p=require('./$PARAMS'); const a=p.FlashArbModule && p.FlashArbModule.aavePool; if(!a) process.exit(1); console.log(a)") \
            || { echo "No FlashArbModule.aavePool in $PARAMS" >&2; exit 1; }
        TMP_PARAMS=$(mktemp --suffix=.json)
        echo "{ \"TokenProbeModule\": { \"aavePool\": \"$POOL\" } }" > "$TMP_PARAMS"
        PARAMS_ARG="--parameters $TMP_PARAMS"
    fi
fi

CHAIN_ID=$(node --input-type=module -e "
import JSON5 from 'json5'; import { readFileSync } from 'node:fs';
const c = JSON5.parse(readFileSync('conf/${CHAIN}.json5', 'utf8'));
if (c?.chain?.id) process.stdout.write(String(c.chain.id));" 2>/dev/null)
[ -z "$CHAIN_ID" ] && CHAIN_ID=$(node --experimental-strip-types --disable-warning=ExperimentalWarning -e "
const { loadChainConfig } = await import('./source/util/config.ts'); process.stdout.write(String(loadChainConfig('${CHAIN}').chain.id));" 2>/dev/null)
if [ -z "$CHAIN_ID" ]; then echo "Could not read the chain id for $CHAIN (conf/${CHAIN}.json5 / conf/@chains.json5)" >&2; exit 1; fi
DEPLOYMENT_ID="chain-${CHAIN_ID}"
JOURNAL="ignition/deployments/${DEPLOYMENT_ID}/journal.jsonl"

export HARDHAT_IGNITION_CONFIRM_DEPLOYMENT=false
mkdir -p "log/${CHAIN}"
LOG="log/${CHAIN}/${STAGE}.log"

check() { node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/deploy-check.ts "$CHAIN" "$CONTRACT" "$FIELD" "$FUTURE"; }

{
    set -o pipefail
    cleanup() {
        [ -n "$TMP_PARAMS" ] && rm -f "$TMP_PARAMS"
        if [ "$BIGBLOCKS" = "1" ]; then
            echo ""; echo "[deploy] big blocks off (this key trades — it must not stay on one-minute blocks)"
            node scripts/hyperevm-bigblocks.mjs off $BB_NET || echo "  [!] could not turn big blocks off — run: yarn bigblocks off $BB_NET"
        fi
    }
    trap cleanup EXIT

    echo "[deploy] ${CONTRACT} on ${CHAIN} (${DEPLOYMENT_ID})"
    yarn -s hardhat compile || exit 1

    RESULT=$(check); RC=$?
    echo "[deploy] check: ${RESULT}"
    if [ "$CHECK_ONLY" = "1" ]; then exit $RC; fi
    case $RC in
        0) if [ "$FORCE" != "1" ]; then echo "[deploy] up to date — nothing to do (--force to deploy a fresh copy anyway)"; exit 0; fi
           echo "[deploy] --force: deploying a fresh copy although the code is current" ;;
        3) echo "[deploy] not deployed — deploying" ;;
        4) echo "[deploy] out of date — deploying the current contracts/${CONTRACT}.sol" ;;
        5) echo "[deploy] refusing: a transaction from the deployer is still in flight (see above). Re-run once it lands."; exit 1 ;;
        *) echo "[deploy] refusing: could not tell whether the deployed code is current (see above)."; exit 1 ;;
    esac

    # Ignition keys on the future id: an existing record — stale, or for code we
    # are replacing — must go, or it reports "Nothing new to deploy".
    if [ -f "$JOURNAL" ] && grep -q "\"${FUTURE}\"" "$JOURNAL"; then
        echo "[deploy] wiping Ignition's record of ${FUTURE} so the new code is actually deployed"
        yarn -s hardhat ignition wipe "$DEPLOYMENT_ID" "$FUTURE" || exit 1
    fi

    # HyperEVM: deployments exceed the small-block gas limit.
    BIGBLOCKS=0; BB_NET=""
    if [ "$CHAIN_ID" = "999" ] || [ "$CHAIN_ID" = "998" ]; then
        [ "$CHAIN_ID" = "998" ] && BB_NET="--testnet"
        node scripts/hyperevm-bigblocks.mjs on $BB_NET || exit 1
        BIGBLOCKS=1
    fi

    yarn -s hardhat ignition deploy "ignition/modules/${MODULE}.ts" --network "$CHAIN" $PARAMS_ARG || exit 1

    sh scripts/log.sh source/util contract-update "$CHAIN" || exit 1

    RESULT=$(check); RC=$?
    echo "[deploy] after deploy: ${RESULT}"
    if [ $RC -ne 0 ]; then
        echo "[deploy] [!] the configured ${FIELD} still does not hold the current ${CONTRACT} — check the Ignition output above"
        exit 1
    fi
    echo "[deploy] done: chain.${FIELD} in conf/${CHAIN}.json5 now points at the current ${CONTRACT}"
} 2>&1 | tee "$LOG"
exit ${PIPESTATUS[0]}
