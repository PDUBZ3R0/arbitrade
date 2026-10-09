#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Container entrypoint (see Containerfile). Runs as PID 1's child under tini.
#
#   1. First boot: copy the image's seed DB into the /app/db volume.
#   2. MANUAL_ON_BOOT=1: refresh the DB with scripts/manual.sh (scan → reserves
#      → cleanup → tokens → probe → triangles). A failure is reported and the
#      loops start anyway on the DB as it is.
#   3. The hot loop and the liquidation watcher, side by side. Either one that
#      exits is restarted after 10s, doubling to 5 min while it keeps failing
#      fast; a run that lasted 10+ min resets the delay.
#
# Environment (defaults in the Containerfile):
#   CHAIN           baked in at build time
#   MODE            test (simulate only) | live (broadcast; needs PRIVATE_KEY)
#   HOT_ARGS        extra args for yarn hot      (default: as scripts/all.sh)
#   LIQ_ARGS        extra args for yarn liquidator (default: --follow)
#   LIQUIDATE       auto | 1 | 0 — run liquidations (dry run in test mode).
#                   auto = only if conf/<chain>.json5 has chain.liquidator.
#   RUN_HOT, RUN_LIQ  1 | 0 — turn either loop off
#
# Logs: everything goes to the container's stdout, prefixed [manual] / [hot] /
# [liq]; the yarn scripts also write log/<chain>/<stage>.log (/app/log volume).
# -----------------------------------------------------------------------------
set -uo pipefail
cd "${APP_DIR:-/app}"
SEED_DIR="${SEED_DIR:-/opt/seed/db}"

: "${CHAIN:?CHAIN is not set (build with --build-arg CHAIN=<chain>)}"
MODE="${MODE:-test}"
case "$MODE" in test|live) ;; *) echo "MODE must be test or live (got $MODE)" >&2; exit 1 ;; esac

ts() { date -u +%FT%TZ; }
say() { echo "[entry $(ts)] $*"; }

# --- 1. seed the DB volume -------------------------------------------------------
if [ ! -f "db/${CHAIN}.sqlite" ]; then
    say "first boot: seeding db/ from the image ($(du -sh "$SEED_DIR" | cut -f1))"
    cp -a "$SEED_DIR"/. db/
fi

if [ -z "${PRIVATE_KEY:-}" ]; then
    # Both loops need it even to simulate: the executors are owner-only.
    say "PRIVATE_KEY is not set (pass --env-file .env)"; exit 1
fi
say "chain ${CHAIN}, mode ${MODE}"

# --- 2. loops ---------------------------------------------------------------------
# supervise <name> <cmd...>: run forever, restart with backoff.
supervise() {
    local name=$1; shift
    local delay=10 start rc
    while :; do
        start=$SECONDS
        say "[$name] start: $*"
        "$@" 2>&1 | sed -u "s/^/[$name] /"
        rc=${PIPESTATUS[0]}
        if (( SECONDS - start >= 600 )); then delay=10; fi
        say "[$name] exited (rc $rc) after $(( SECONDS - start ))s; restarting in ${delay}s"
        sleep "$delay"
        delay=$(( delay * 2 > 300 ? 300 : delay * 2 ))
    done
}

live_flag=()
[ "$MODE" = live ] && live_flag=(--live)

# word-split HOT_ARGS / LIQ_ARGS on purpose: they are flag lists
read -r -a hot_args <<< "${HOT_ARGS---gas-margin 1.5 --candidates 20}"
read -r -a liq_args <<< "${LIQ_ARGS---follow}"

liquidate="${LIQUIDATE:-auto}"
if [ "$liquidate" = auto ]; then
    if node -e "
        const c = require('json5').parse(require('fs').readFileSync('conf/${CHAIN}.json5', 'utf8'));
        process.exit(c.chain && c.chain.liquidator ? 0 : 1);" 2>/dev/null; then
        liquidate=1
    else
        liquidate=0
        say "no chain.liquidator in conf/${CHAIN}.json5: liq-watch watches only (yarn deploy-liquidator ${CHAIN} && yarn contract-update ${CHAIN}, then rebuild)"
    fi
fi
liq_mode=()
if [ "$liquidate" = 1 ]; then
    if [ "$MODE" = live ]; then liq_mode=(--live); else liq_mode=(--liquidate); fi
fi

pids=()
if [ "${RUN_HOT:-1}" = 1 ]; then
    supervise arbitrage yarn --silent all "${live_flag[@]}" "$CHAIN" "${hot_args[@]}"  &
    pids+=($!)
fi
if [ "${RUN_LIQ:-1}" = 1 ]; then
    supervise liquidate yarn --silent liquidator "$CHAIN" "${liq_args[@]}" "${liq_mode[@]}" &
    pids+=($!)
fi
if [ ${#pids[@]} -eq 0 ]; then say "RUN_HOT=0 and RUN_LIQ=0: nothing to run"; exit 0; fi

# tini -g delivers stop signals to the whole process group (both node processes
# included); this shell just waits.
wait
