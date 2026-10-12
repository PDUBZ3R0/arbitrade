#!/usr/bin/env bash
# Run on YOUR machine: download the instance's logs that push-logs.sh put in S3.
#
#   bash scripts/aws/pull-logs.sh <bucket> [<chain> ...]     (no chain = all)
#   bash scripts/aws/pull-logs.sh arbitrade-seed-pdubz base
#
# They land in log/aws/<chain>/ — beside, never over, your local log/<chain>/.
set -euo pipefail
BUCKET="${1:?usage: pull-logs.sh <bucket> [<chain> ...]}"; shift
REGION="${AWS_REGION:-us-east-1}"
cd "$(dirname "$0")/../.."
mkdir -p log/aws
if [ $# -eq 0 ]; then
    aws s3 sync --region "$REGION" --only-show-errors "s3://${BUCKET}/logs/" log/aws/
else
    for c in "$@"; do aws s3 sync --region "$REGION" --only-show-errors "s3://${BUCKET}/logs/$c/" "log/aws/$c/"; done
fi
for d in log/aws/*/; do
    [ -d "$d" ] || continue
    newest=$(ls -t "$d" 2>/dev/null | head -1)
    echo "  ${d%/}: $(ls "$d" | wc -l) file(s), newest ${newest:-–}"
done
