#!/bin/sh
# Run one stage for one chain, teeing output to log/<chain>/<stage>.log.
# Usage (via package.json): sh scripts/log.sh <dir> <stage> <chain> [args…]
#
# POSIX sh, not bash: package.json runs this with `sh`, which is dash on
# Debian/Ubuntu/Mint. No `==` in [ ], no arrays, no PIPESTATUS.
set -e

ROOT="$1"
STAGE="$2"
CHAIN="$3"

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn $STAGE <chain>" >&2
    exit 1
fi
shift 3
# The remaining arguments stay in "$@", so ones with spaces survive intact.

CALLLOG="$USER@$HOSTNAME:$(pwd)\$ yarn $STAGE $CHAIN $*"

if [ "$CONTAINED" = "YEAH" ]; then
    LDIR="/app/log/${CHAIN}"
else
    LDIR="log/${CHAIN}"
fi

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
    echo "$CALLLOG"
    echo "=== $STAGE ($CHAIN) ==="
    rc=0
    node --experimental-strip-types --disable-warning=ExperimentalWarning "$ROOT/$STAGE.ts" "$CHAIN" "$@" || rc=$?
    echo $rc > "$STATUS_FILE"
    echo

} 2>&1 | tee "$LOG"
RC=$(cat "$STATUS_FILE" 2>/dev/null)
rm -f "$STATUS_FILE"
# Empty means the block above died before recording a status: a failure.
[ -n "$RC" ] || RC=1
if [ "$RC" != "0" ]; then
    echo "[✗] yarn $STAGE $CHAIN failed (exit $RC) — see $LOG" >&2
fi
exit "$RC"
