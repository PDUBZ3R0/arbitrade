# -----------------------------------------------------------------------------
# arbitrade, one chain per image: the chain's conf is baked in; the seed DB is
# NOT — it is mounted read-only from the host and copied into the volume on first
# boot. At boot the pipeline (scripts/manual.sh) refreshes the DB, then the hot
# loop and the liquidation watcher run side by side, each restarted if it exits.
# See scripts/container-entry.sh for the runtime knobs.
#
# Build (podman or docker, from the repo root):
#   podman build -f Containerfile --build-arg CHAIN=base -t arbitrade:base .
#
# Run (secrets come from .env at RUN time — nothing secret is in the image; the
# seed DB is mounted read-only from the host's ./db):
#   podman run -d --name arb-base --restart unless-stopped \
#       --env-file .env -v "$(pwd)/db:/opt/seed/db:ro" \
#       -v arb-base-db:/app/db -v arb-base-log:/app/log \
#       arbitrade:base                      # dry run: simulate, send nothing
#   ... -e MODE=live arbitrade:base         # broadcast (PRIVATE_KEY in .env)
#
# The host's seed DB (mounted at /opt/seed/db) is only the STARTING point: on
# first boot it is copied into the /app/db volume, and from then on the volume is
# the live copy (the pipeline and both loops write to it). Rebuilding the image
# does NOT touch an existing volume, so a rebuild never stomps live data; delete
# the volume to re-seed from the host. If no seed is mounted, the volume starts
# empty and manual.sh builds the DB from scratch on first boot.
#
# Keeping the DB (hundreds of MB on a big chain) out of the image is what stops
# image layers — and the containerd/overlay store — from ballooning on rebuilds.
#
# Before (re)seeding, fold any WAL into the main file so the host copy is
# consistent (or stop the chain's processes first):
#   sqlite3 db/base.sqlite 'PRAGMA wal_checkpoint(TRUNCATE)'
# -----------------------------------------------------------------------------

ARG NODE_VERSION=24

# --- dependencies (native modules built here: better-sqlite3, hypersync) -------
FROM docker.io/library/node:${NODE_VERSION}-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json yarn.lock ./
# Runtime deps only: hardhat / viem are for deploying, not for running.
RUN yarn install --production --frozen-lockfile --network-timeout 600000 \
 && yarn cache clean

# --- runtime -------------------------------------------------------------------
FROM docker.io/library/node:${NODE_VERSION}-bookworm-slim
ARG CHAIN
RUN test -n "$CHAIN" || { echo 'build with --build-arg CHAIN=<chain> (e.g. base, optimism, arbitrum)' >&2; exit 1; }

# tini: PID 1 that reaps zombies and (-g) forwards stop signals to every process.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/*

ENV CHAIN=${CHAIN} \
    NODE_ENV=production \
    MODE=test \
    MANUAL_ON_BOOT=1 \
    HOT_ARGS="--gas-margin 1.5 --candidates 20" \
    LIQ_ARGS="--follow" \
    LIQUIDATE=auto

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node source ./source
COPY --chown=node:node scripts ./scripts
# The registry, the chain's config and its blacklist (<chain>-blacklist.json5) if any.
COPY --chown=node:node conf/@chains.json5 conf/${CHAIN}*.json5 ./conf/
# The seed DB is NOT copied in — it is mounted read-only from the host at
# /opt/seed/db at run time (see compose.yaml / the run example above), and the
# entry script copies it into the /app/db volume only on first boot. This keeps
# the big SQLite out of the image layers. /opt/seed/db is created here as the
# mount point; it is empty in the image.
RUN mkdir -p /app/db /app/log /opt/seed/db && chown node:node /app /app/db /app/log /opt/seed /opt/seed/db

USER node
VOLUME ["/app/db", "/app/log"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "bash", "/app/scripts/container-entry.sh"]