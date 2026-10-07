#!/usr/bin/env bash
# Run on YOUR machine: store .env in SSM Parameter Store as one encrypted
# SecureString (/arbitrade/env). The instance reads it at setup; nothing secret
# goes into git, the image, or EC2 user data.
#
#   bash scripts/aws/push-env.sh            # region from AWS_REGION, else us-east-1
#
# Re-run after any change to .env, then on the instance:
#   sudo bash /opt/arbitrade/scripts/aws/setup-instance.sh   (re-fetches it, recreates the containers)
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
NAME="${ARB_ENV_PARAM:-/arbitrade/env}"
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "no .env here" >&2; exit 1; }
grep -q '^PRIVATE_KEY=0x[0-9a-fA-F]\{64\}' .env || echo "warning: .env has no PRIVATE_KEY=0x<64 hex> line" >&2
aws ssm put-parameter --region "$REGION" --name "$NAME" --type SecureString \
    --value "file://.env" --overwrite --tier Standard >/dev/null
echo "stored .env ($(wc -c < .env) bytes) as $NAME in $REGION"
