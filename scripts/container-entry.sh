#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Container entrypoint (see Containerfile). Runs as PID 1's child under tini.
#
#   1. First boot: copy the image's seed DB into the /app/db volume.
#   2. Refresh the DB with (scan → reserves → cleanup → tokens)
#   3. If RUNS is 'all' or 'arbitrage' run (probe → triangles → evaluate → hot).
#   3. If RUNS is 'all' or 'liquidate' run (liq).
#
# Environment (defaults in the Containerfile):
#   CHAIN           baked in at build time
#   MODE            test (simulate only) | live (broadcast; needs PRIVATE_KEY)
#   RUNS            all|liquidate|arbitrage
#
# Logs: everything goes to the container's stdout, prefixed.
# -----------------------------------------------------------------------------
set -uo pipefail
cd "${APP_DIR:-/app}"
SEED_DIR="${SEED_DIR:-/opt/seed/db}"

: "${CHAIN:?CHAIN is not set (build with --build-arg CHAIN=<chain>)}"
MODE="${MODE:-test}"
case "$MODE" in test|live) ;; *) echo "MODE must be test or live (got $MODE)" >&2; exit 1 ;; esac

ts() { date -u +%FT%TZ; }
say() { echo "[entry $(ts)] $*"; }

export CONTAINED="YEAH"

# --- 1. seed the DB volume -------------------------------------------------------
# The volume is the live copy. Seed it ONLY when it has no DB yet (first boot or
# a deleted volume) — never on a rebuild, so a rebuild can't stomp live data. The
# seed comes from the host-mounted /opt/seed/db (read-only); if nothing is
# mounted there, start empty and let manual.sh build the DB from scratch.
if [ ! -f "db/${CHAIN}.sqlite" ]; then
    if [ -f "$SEED_DIR/${CHAIN}.sqlite" ]; then
        # Copy only THIS chain's files — the host ./db holds every chain's seed,
        # and the mount exposes all of them.
        say "first boot: seeding db/ for ${CHAIN} from mounted $SEED_DIR ($(du -ch "$SEED_DIR/${CHAIN}".sqlite* 2>/dev/null | tail -1 | cut -f1))"
        cp -a "$SEED_DIR/${CHAIN}".sqlite* db/
    else
        say "first boot: no seed at $SEED_DIR/${CHAIN}.sqlite (mount the host's ./db read-only there to seed) — starting empty; manual.sh will build the DB"
    fi
fi

if [ -z "${PRIVATE_KEY:-}" ]; then
    # Both loops need it even to simulate: the executors are owner-only.
    say "PRIVATE_KEY is not set (pass --env-file .env)"; exit 1
fi
say "chain ${CHAIN}, mode ${MODE}"

live_flag=()
[ "$MODE" = live ] && live_flag=(--live)

yarn $RUNS $CHAIN $live_flag

wait