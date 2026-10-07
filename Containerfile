# -----------------------------------------------------------------------------
# arbitrade, one chain per image: the chain's pool DB + liquidation watchlist and
# its conf are baked in; at boot the pipeline (scripts/manual.sh) refreshes the
# DB, then the hot loop and the liquidation watcher run side by side, each
# restarted if it exits. See scripts/container-entry.sh for the runtime knobs.
#
# Build (podman or docker, from the repo root):
#   podman build -f Containerfile --build-arg CHAIN=base -t arbitrade:base .
#
# Run (secrets come from .env at RUN time — nothing secret is in the image):
#   podman run -d --name arb-base --restart unless-stopped \
#       --env-file .env -v arb-base-db:/app/db -v arb-base-log:/app/log \
#       arbitrade:base                      # dry run: simulate, send nothing
#   ... -e MODE=live arbitrade:base         # broadcast (PRIVATE_KEY in .env)
#
# The DB in the image is only the STARTING point: on first boot it is copied
# into the /app/db volume, and from then on the volume is the live copy (the
# pipeline and both loops write to it). Rebuilding the image does not touch an
# existing volume; delete the volume to start again from the image's DB.
#
# Before building, fold any WAL into the main file so the copy is consistent
# (or stop the chain's processes first):
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
# Seed DB: <chain>.sqlite (pools, triangles) and <chain>-liq.sqlite (watchlist).
COPY --chown=node:node db/${CHAIN}*.sqlite* /opt/seed/db/

RUN test -f "/opt/seed/db/${CHAIN}.sqlite" || { echo "db/${CHAIN}.sqlite is missing — run yarn manual ${CHAIN} on the host first" >&2; exit 1; }
# Not chown -R: that would copy every file into a new layer (the seed DB can be GBs).
RUN mkdir -p /app/db /app/log && chown node:node /app /app/db /app/log /opt/seed /opt/seed/db

USER node
VOLUME ["/app/db", "/app/log"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "bash", "/app/scripts/container-entry.sh"]
