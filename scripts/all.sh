#!/bin/bash

CHAIN=$2
KEYWORD=$1
shift 2

if [ -z "$CHAIN" ]||[ -z "$KEYWORD" ]; then
    echo "Usage: yarn <arbitrage|liquidate|all> <chain>" >&2
    exit 1
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
    yarn scan $CHAIN && \
        yarn reserves $CHAIN --blacklist-dead && \
        yarn cleanup $CHAIN --empty --yes && \
        yarn tokens $CHAIN 
}

logd "@startup@" runstart

if [[ "$KEYWORD" = "L" ]]; then
    supervise 'liquidate' yarn liq $CHAIN --follow $LIVENESS
elif [[ "$KEYWORD" = "_" ]]; then
    supervise 'liquidate' yarn liq $CHAIN --follow $LIVENESS &
fi

if [[ "$KEYWORD" = "A" || "$KEYWORD" = "_" ]]; then
    logd 'arbitrage' yarn probe $CHAIN --blacklist-restricted > /dev/null && echo '[probe] complete'
    logd 'arbitrage' yarn triangles $CHAIN && echo "[triangles] complete" 
    logd 'arbitrage' yarn evaluate $CHAIN --verbose
    supervise 'arbitrage' yarn hot $CHAIN --gas-margin 1.5 --candidates 20 $LIVENESS
fi

