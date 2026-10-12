#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Run ON THE EC2 INSTANCE (as root): copy every chain's logs to S3.
#
#   sudo BUCKET=<bucket> bash /opt/arbitrade/scripts/aws/push-logs.sh
#
# setup-instance.sh installs a systemd timer that runs this every
# LOG_SYNC_MINUTES (default 15); run it by hand for an immediate push.
#
# What goes up, per compose service (running or stopped):
#   s3://<bucket>/logs/<chain>/*.log          the yarn stage logs (/app/log in
#                                             the container, a docker volume)
#   s3://<bucket>/logs/<chain>/container.log  the container's stdout — the
#                                             [entry]/[arbitrage]/[liquidate]
#                                             lines — last 48h; only with the
#                                             json-file log driver (with
#                                             CLOUDWATCH=1 it is in CloudWatch)
# `aws s3 sync` uploads only files that changed. Pull them to your machine with
# scripts/aws/pull-logs.sh.
# -----------------------------------------------------------------------------
set -euo pipefail
BUCKET="${BUCKET:?set BUCKET=<bucket>}"
DIR="${DIR:-/opt/arbitrade}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.aws.yaml}"
SINCE="${SINCE:-48h}"
cd "$DIR"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

services=$(dc ps -a --services 2>/dev/null || true)
[ -n "$services" ] || { echo "no containers for $COMPOSE_FILE in $DIR — nothing to push"; exit 0; }

for c in $services; do
    mkdir -p "$STAGE/$c"
    # The stage logs live in the container's /app/log volume; docker cp reads it
    # from stopped containers too.
    dc cp "$c:/app/log/." "$STAGE/$c/" >/dev/null 2>&1 || echo "  ($c: no /app/log to copy)"
    # The image keeps per-chain logs under log/<chain>/ — flatten that level.
    if [ -d "$STAGE/$c/$c" ]; then cp -a "$STAGE/$c/$c/." "$STAGE/$c/" && rm -rf "${STAGE:?}/$c/$c"; fi
    dc logs --no-color --timestamps --since "$SINCE" "$c" > "$STAGE/$c/container.log" 2>/dev/null \
        || rm -f "$STAGE/$c/container.log"      # awslogs driver: not readable here
    [ -s "$STAGE/$c/container.log" ] || rm -f "$STAGE/$c/container.log"
done

aws s3 sync --only-show-errors "$STAGE/" "s3://$BUCKET/logs/"
echo "$(date -u +%FT%TZ) pushed logs for: $(echo $services) → s3://$BUCKET/logs/"
