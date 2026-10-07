#!/usr/bin/env bash
# Run on YOUR machine: upload a chain's databases to S3 so the instance can
# start from them instead of re-scanning the chain from scratch.
#
#   bash scripts/aws/push-db.sh <bucket> <chain> [<chain> ...]
#   bash scripts/aws/push-db.sh arbitrade-seed-pdubz base optimism arbitrum
#
# Stop that chain's processes first (hot, liq-watch, scan…): the WAL is folded
# into the main file before upload, so the copy is consistent.
set -euo pipefail
BUCKET="${1:?usage: push-db.sh <bucket> <chain> [<chain> ...]}"; shift
[ $# -gt 0 ] || { echo "name at least one chain" >&2; exit 1; }
REGION="${AWS_REGION:-us-east-1}"
cd "$(dirname "$0")/../.."
command -v sqlite3 >/dev/null || { echo "needs the sqlite3 CLI (apt install sqlite3)" >&2; exit 1; }
for CHAIN in "$@"; do
    for f in "db/${CHAIN}.sqlite" "db/${CHAIN}-liq.sqlite"; do
        [ -f "$f" ] || { echo "skip $f (not found)"; continue; }
        sqlite3 "$f" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null
        echo "uploading $f ($(du -h "$f" | cut -f1))…"
        aws s3 cp --region "$REGION" --only-show-errors "$f" "s3://${BUCKET}/db/$(basename "$f")"
    done
done
echo done
