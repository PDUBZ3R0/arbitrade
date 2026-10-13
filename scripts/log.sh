#!/bin/sh
# Run the full data pipeline for one chain, teeing output to <chain>.log.
# Usage: yarn manual <chain>
set -e

ROOT="$1"
shift

STAGE="$1"
shift

CHAIN="$1"

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain>" >&2
    exit 1
fi

shift

if [[ "$CONTAINED" == "YEAH" ]]; then
    LDIR="/app/log/${CHAIN}"
else
    LDIR="log/${CHAIN}"
fi

CALLLOG="$USER@$HOSTNAME:$(pwd)\$ yarn $STAGE $CHAIN $@"

LOG="$LDIR/${STAGE}.log"
if [ ! -d "$LDIR" ]; then
    mkdir -p "$LDIR"
fi

# The exit status of `{ … } | tee` is tee's — always 0 — so a stage that
# crashed used to look successful, and `yarn manual` carried on (reserves died
# on Sonic, and tokens/probe/triangles/evaluate then ran on 2-day-old reserves).
# sh has no pipefail: the stage writes its own status to a file, and that is
# what this script exits with.
STATUS_FILE=$(mktemp)
{
    echo $CALLLOG
    echo "=== $STAGE ($CHAIN) ==="
    rc=0
    node --experimental-strip-types --disable-warning=ExperimentalWarning $ROOT/$STAGE.ts "$CHAIN" $@ || rc=$?
    echo $rc > "$STATUS_FILE"
    echo

} 2>&1 | tee "$LOG"
RC=$(cat "$STATUS_FILE" 2>/dev/null || echo 1)
rm -f "$STATUS_FILE"
if [ "$RC" != "0" ]; then
    echo "[✗] yarn $STAGE $CHAIN failed (exit $RC) — see $LOG" >&2
fi
exit "$RC"
