#!/bin/bash
# Deploy the project's contracts to a chain — only what needs it.
#
# Usage: bash scripts/deploy.sh <flasharb|liquidator|contract|probe|sniper|all> <chain> [--force] [--check]
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
#        found    -> the deployer already created a contract with this exact
#                    code (a deploy Ignition called "dropped" that landed):
#                    point the config at it — no deploy
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
    [ -z "$CHAIN" ] && { echo "Usage: yarn deploy all <chain> [--check]" >&2; exit 2; }
    for w in contract flasharb probe liquidator; do
        if ! bash "$0" "$w" "$CHAIN" "$@"; then
            case " $* " in *" --check "*) continue ;; esac   # --check: report every contract
            echo "" >&2
            echo "[deploy] ${w} failed — stopping. See log/${CHAIN}/deploy-*.log; re-run when fixed." >&2
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
    sniper)     CONTRACT=SniperExecutor;      FIELD=sniper;     MODULE=SniperModule;      STAGE=deploy-sniper ;;
    *) echo "Usage: yarn deploy <flasharb|liquidator|contract|probe|sniper|all> <chain> [--force] [--check]" >&2; exit 2 ;;
esac
FUTURE="${MODULE}#${CONTRACT}"
if [ -z "$CHAIN" ] || [ "${CHAIN#--}" != "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain> [--force] [--check]" >&2; exit 2
fi

# Constructor parameters. FlashArbExecutor and TokenProbe take the chain's Aave
# pool from ignition/parameters/<chain>.json (address(0) where there is none —
# both then borrow from the conf's flashloan lender by SOURCE id instead).
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

# SniperExecutor's owner: sniper's hot wallet (SNIPER_OWNER, else SniperModule.owner in the
# parameters file). Not the deployer: the deployer must never control sniper's funds.
if [ "$WHAT" = "sniper" ]; then
    OWNER="${SNIPER_OWNER:-}"
    if [ -z "$OWNER" ] && [ -f "$PARAMS" ]; then
        OWNER=$(node -e "const p=require('./$PARAMS'); const a=p.SniperModule && p.SniperModule.owner; if(a) console.log(a)")
    fi
    case "$OWNER" in
        0x[0-9a-fA-F]*) [ ${#OWNER} -eq 42 ] || OWNER="" ;;
        *) OWNER="" ;;
    esac
    if [ -z "$OWNER" ]; then
        echo "SniperExecutor needs its owner, sniper's hot wallet address: SNIPER_OWNER=0x… yarn deploy sniper $CHAIN" >&2
        echo '  (or { "SniperModule": { "owner": "0x…" } } in '"$PARAMS"')' >&2
        exit 1
    fi
    export SNIPER_OWNER="$OWNER"
    TMP_PARAMS=$(mktemp --suffix=.json)
    echo "{ \"SniperModule\": { \"owner\": \"$OWNER\" } }" > "$TMP_PARAMS"
    PARAMS_ARG="--parameters $TMP_PARAMS"
fi

CHAIN_ID=$(node --input-type=module -e "
import JSON5 from 'json5'; import { readFileSync } from 'node:fs';
const c = JSON5.parse(readFileSync('conf/@chains.json5', 'utf8'));
if (c['$CHAIN']?.id) process.stdout.write(String(c['$CHAIN']?.id));" 2>/dev/null)
if [ -z "$CHAIN_ID" ]; then echo "Could not read the chain id for $CHAIN (conf/${CHAIN}.json5 / conf/@chains.json5)" >&2; exit 1; fi
DEPLOYMENT_ID="chain-${CHAIN_ID}"
JOURNAL="ignition/deployments/${DEPLOYMENT_ID}/journal.jsonl"

export HARDHAT_IGNITION_CONFIRM_DEPLOYMENT=false

# One RPC for everything: hardhat.config.ts reads <LABEL>_RPC with its own
# per-network fallback (dRPC for HyperEVM), the bot reads <LABEL>_RPC or
# conf/@chains.json5. Resolve it the bot's way and hand Hardhat the same URL,
# so the checker and the deploy never ask different nodes about the same nonce.
RPC_HOST=$(node --experimental-strip-types --disable-warning=ExperimentalWarning -e "
const { loadChainConfig } = await import('./source/util/config.ts'); process.stdout.write(loadChainConfig('${CHAIN}').chain.host);" 2>/dev/null)
if [ -n "$RPC_HOST" ]; then
    RPC_ENV="$(echo "$CHAIN" | tr '[:lower:]-' '[:upper:]_')_RPC"
    export "$RPC_ENV=$RPC_HOST"
fi
# No host: the chain is served by the rated pool, which a deploy can't use (one node must see
# the nonce and the transaction). Hardhat then got an empty URL: "unsupported protocol".
if [ -z "$RPC_HOST" ]; then
    RPC_ENV="$(echo "$CHAIN" | tr '[:lower:]-' '[:upper:]_')_RPC"
    echo "[deploy] no RPC for $CHAIN: set $RPC_ENV in .env (or on the command line) to one node to deploy through." >&2
    node -e "
const f = 'conf/provider/${CHAIN_ID}.json'; let d; try { d = require('./' + f); } catch { process.exit(0); }
const ok = d.endpoints.filter(e => e.kind === 'http' && e.reachable && e.chainIdOk && !(e.batch && e.batch.error)).slice(0, 4);
if (ok.length) console.error('  rated endpoints that answered cleanly (' + f + '):\\n' + ok.map(e => '    ' + e.url).join('\\n'));" || true
    exit 1
fi
RPC_SHOWN=$(echo "$RPC_HOST" | sed -E 's#(/[^/]{20,})$#/***#')
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

    echo "[deploy] ${CONTRACT} on ${CHAIN} (${DEPLOYMENT_ID}) via ${RPC_SHOWN:-hardhat default RPC}"
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
        6) FOUND=$(echo "$RESULT" | awk '{print $2}')
           if [ "$FORCE" != "1" ]; then
               echo "[deploy] adopting ${FOUND}: setting chain.${FIELD} instead of deploying a duplicate"
               sh scripts/log.sh source/util contract-update "$CHAIN" --set "${FIELD}=${FOUND}" || exit 1
               RESULT=$(check); RC=$?
               echo "[deploy] after adopting: ${RESULT}"
               [ $RC -eq 0 ] || { echo "[deploy] [!] still not current after adopting ${FOUND}"; exit 1; }
               echo "[deploy] done: chain.${FIELD} in conf/${CHAIN}.json5 now points at the current ${CONTRACT}"
               exit 0
           fi
           echo "[deploy] --force: deploying a fresh copy although ${FOUND} already has the current code" ;;
        *) echo "[deploy] refusing: could not tell whether the deployed code is current (see above)."; exit 1 ;;
    esac

    # HyperEVM (999 mainnet / 998 testnet): no Ignition. Its tracker calls every
    # big-block deploy "dropped" (the RPC does not report the transaction while
    # it waits for the one-minute block) and aborts, although it lands.
    # scripts/deploy-direct.ts sends the create and waits for the receipt or the
    # code instead. Ignition's journal for these chains is then simply not
    # updated; contract-update's downgrade guard keeps it from undoing this.
    DIRECT=1
#    if [ "$CHAIN_ID" = "999" ] || [ "$CHAIN_ID" = "998" ]; then DIRECT=1; fi

    # Ignition keys on the future id: an existing record — stale, or for code we
    # are replacing — must go, or it reports "Nothing new to deploy".
    if [ "$DIRECT" = "0" ] && [ -f "$JOURNAL" ] && grep -q "\"${FUTURE}\"" "$JOURNAL"; then
        echo "[deploy] wiping Ignition's record of ${FUTURE} so the new code is actually deployed"
        yarn -s hardhat ignition wipe "$DEPLOYMENT_ID" "$FUTURE"
    fi
    # Any OTHER future Ignition still thinks is pending (a deploy it called
    # "dropped" that landed and was adopted) poisons its nonce check for every
    # module on this chain (HHE10411 "should be N, but the node reports N+1").
    # The check above already proved nothing is in flight, so those records
    # are dead — clear them. See scripts/ignition-stuck.mjs.
    [ "$DIRECT" = "0" ] && for STUCK in $(node scripts/ignition-stuck.mjs "$JOURNAL" "$FUTURE"); do
        echo "[deploy] wiping Ignition's stale pending record of ${STUCK} (it blocks the nonce check; the config is unaffected)"
        yarn -s hardhat ignition wipe "$DEPLOYMENT_ID" "$STUCK" || exit 1
    done

    # HyperEVM: deployments exceed the small-block gas limit.
    BIGBLOCKS=0; BB_NET=""
    SMALL_ARG=""
    if [ "$CHAIN_ID" = "999" ] || [ "$CHAIN_ID" = "998" ]; then
        [ "$CHAIN_ID" = "998" ] && BB_NET="--testnet"
        # Only when the deploy will not fit a small block (2M gas) with a 20%
        # gasLimit margin: big blocks make it wait for the one-minute block.
        EST=$(node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/deploy-direct.ts "$CHAIN" "$CONTRACT" --estimate)
        if [ -n "$EST" ] && [ "$EST" != "unknown" ] && [ "$EST" -le 1666666 ] 2>/dev/null; then
            echo "[deploy] gas estimate ${EST} fits a small block — big blocks stay off"
            SMALL_ARG="--small"
        else
            echo "[deploy] gas estimate ${EST:-unknown} needs a big block"
            node scripts/hyperevm-bigblocks.mjs on $BB_NET || exit 1
            BIGBLOCKS=1
        fi
    fi

    if [ "$DIRECT" = "1" ]; then
        DEPLOYED=$(node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/deploy-direct.ts "$CHAIN" "$CONTRACT" $SMALL_ARG)
        DRC=$?
        if [ $DRC -ne 0 ] || [ -z "$DEPLOYED" ]; then
            echo "[deploy] direct deploy failed (see above). If it landed late, re-running this command adopts it."
            exit 1
        fi
        ADDR=$(echo "$DEPLOYED" | awk '{print $1}')
        echo "[deploy] deployed ${CONTRACT} at ${ADDR} (nonce $(echo "$DEPLOYED" | awk '{print $2}'), tx $(echo "$DEPLOYED" | awk '{print $3}'))"
        sh scripts/log.sh source/util contract-update "$CHAIN" --set "${FIELD}=${ADDR}" || exit 1
        RESULT=$(check); RC=$?
        echo "[deploy] after deploy: ${RESULT}"
        [ $RC -eq 0 ] || { echo "[deploy] [!] the configured ${FIELD} still does not hold the current ${CONTRACT}"; exit 1; }
        echo "[deploy] done: chain.${FIELD} in conf/${CHAIN}.json5 now points at the current ${CONTRACT}"
        exit 0
    fi

    IGN_OUT=$(mktemp)
    yarn -s hardhat ignition deploy "ignition/modules/${MODULE}.ts" --network "$CHAIN" $PARAMS_ARG 2>&1 | tee "$IGN_OUT"
    IGN_RC=${PIPESTATUS[0]}
    if [ "$IGN_RC" -ne 0 ]; then
        if grep -q "HHE10400\|HHE10411\|were dropped\|should be .*but the node reports" "$IGN_OUT"; then
            echo ""
            echo "[deploy] Ignition lost track of a transaction (\"dropped\", or a nonce it did not send)."
            echo "         If the deployer key also trades (hot / liq-watch running on this chain), stop"
            echo "         that service for the deploy: its transactions move the nonce under Ignition."
            echo "         On HyperEVM the deploy often lands anyway — a big block takes up to a minute."
            echo "         Wait a minute, then re-run this same command: if your deployer created the"
            echo "         contract, the check finds it and points the config at it instead of deploying again."
        fi
        rm -f "$IGN_OUT"; exit 1
    fi
    rm -f "$IGN_OUT"

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
