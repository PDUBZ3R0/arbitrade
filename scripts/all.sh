#!/bin/bash

clear
CHAIN=$2
KEYWORD=$1
shift 2

if [ -z "$CHAIN" ]||[ -z "$KEYWORD" ]; then
    echo "Usage: yarn <arbitrage|liquidate|all> <chain>" >&2
    exit 1
fi

if [[ "$KEYWORD" != "L" ]]; then
    ISMEMCHAIN=$(cat conf/mempool/list.conf | grep $CHAIN)

    if [[ "$CHAIN" = "$ISMEMCHAIN" ]]; then
        logd mempool echo "------[ Mempool Mode: Active ][ Chain: $CHAIN) ]------"]
        LIVERUNS="--pending-probe"

        if [[ "$MEMPOOL" = "live" ]]; then
            LIVERUNS="$LIVERUNS --live-backruns"
        fi
    fi
fi

if [[ "$1" = '--live' ]]; then
    LIVENESS="--live"
fi

logd(){
    local name=$1; shift
    "$@" 2>&1 | sed -u "s/^/[$name] /"
}

supervise() {
    local name=$1; shift
    local delay=10 start rc
    while :; do
        start=$SECONDS
        echo "[$name] start: $*"
        logd $name "$@"
        rc=${PIPESTATUS[0]}
        if (( SECONDS - start >= 600 )); then delay=10; fi
        echo "[$name] exited (rc $rc) after $(( SECONDS - start ))s; restarting in ${delay}s"
        sleep "$delay"
        delay=$(( delay * 2 > 300 ? 300 : delay * 2 ))
    done
}

runstart(){
    yarn scan $CHAIN --transport envio && \
    yarn scan $CHAIN && \
        yarn reserves $CHAIN --blacklist-dead && \
        yarn cleanup $CHAIN --empty --yes && \
        yarn tokens $CHAIN 
}

RESERVES="${RESERVES:-30m}"

reserves() {
    while :; do
        sleep $RESERVES
        yarn reserves $CHAIN --blacklist-dead &> /dev/null
        logd '<reserves' echo "refreshed all reserves."
    done
}

# The liquidator starts BEFORE the startup pipeline, not after it. It finds exit
# pools from the factories itself and reads the pool DB live, so the pipeline's
# updates reach it as they land. Gated behind runstart, it never started on
# Polygon, HyperEVM, Monad or Robinhood in the Oct 23-24 run: their scans were
# still going 33h later, through a BTC move with 15 liquidations on Polygon's
# Aave alone.
if [[ "$KEYWORD" = "L" || "$KEYWORD" = "_" ]]; then
    supervise 'liquidate' yarn liq $CHAIN --follow $LIVENESS &
fi

# A liquidator-only run needs no scan: live-pools.ts asks the factories. The DB
# still adds pools outside the usual fee tiers and DexUsd prices, which a chain
# with neither an Aave oracle nor liquidation.usdOracle needs: yarn liquidate
# <chain> --scan keeps the pipeline for those.
if [[ "$KEYWORD" != "L" || " $* " = *" --scan "* ]]; then
    logd "@ startup" runstart
    reserves &
fi

if [[ "$KEYWORD" = "L" ]]; then
    wait
fi

if [[ "$KEYWORD" = "A" || "$KEYWORD" = "_" ]]; then
    logd 'arbitrage' yarn probe $CHAIN --blacklist-restricted &> /dev/null && echo '[probe] complete'
    logd 'arbitrage' yarn triangles $CHAIN && echo "[triangles] complete" 
    ## ogd 'arbitrage' yarn evaluate $CHAIN --verbose
    supervise 'arbitrage' yarn hot $CHAIN --gas-margin 1.5 --candidates 20 $LIVENESS $LIVERUNS
fi
