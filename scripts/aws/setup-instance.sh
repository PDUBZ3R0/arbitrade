#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Run ON THE EC2 INSTANCE (Ubuntu 24.04, x86), as root, from a Session Manager
# shell. Idempotent: the same command first sets the box up, and later pulls
# new code / a changed .env and recreates the containers.
#
#   curl -fsSL https://raw.githubusercontent.com/PDUBZ3R0/arbitrade/liquidations/scripts/aws/setup-instance.sh -o /tmp/setup.sh
#   sudo BUCKET=<seed-bucket> CHAINS="base" bash /tmp/setup.sh
#
# Afterwards (code or .env changed):
#   sudo BUCKET=<seed-bucket> CHAINS="base" bash /opt/arbitrade/scripts/aws/setup-instance.sh
#
# Variables:
#   BUCKET      S3 bucket that push-db.sh uploaded the databases to (required
#               the first time; the downloaded files are kept for rebuilds)
#   CHAINS      space-separated compose services to run (default: base)
#   BRANCH      git branch (default: liquidations)
#   CLOUDWATCH  1 = container logs to CloudWatch (compose.aws.yaml), 0 = local (default)
#   ARB_ENV_PARAM  SSM parameter holding .env (default: /arbitrade/env)
#
# What lives where on the box:
#   /opt/arbitrade             the repo (build context) + .env (mode 600)
#   /opt/arbitrade/db/         seed DBs from S3 — only used to BUILD images
#   docker volumes arbitrade_<chain>-db / -log   the LIVE databases and logs
# -----------------------------------------------------------------------------
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

REPO_URL="${REPO_URL:-https://github.com/PDUBZ3R0/arbitrade.git}"
BRANCH="${BRANCH:-liquidations}"
DIR=/opt/arbitrade
CHAINS="${CHAINS:-base}"
CLOUDWATCH="${CLOUDWATCH:-0}"
PARAM="${ARB_ENV_PARAM:-/arbitrade/env}"
say() { echo -e "\n==> $*"; }

# Region from instance metadata (IMDSv2), unless given.
if [ -z "${AWS_REGION:-}" ]; then
    T=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
    AWS_REGION=$(curl -fsS -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/placement/region)
fi
export AWS_REGION

# --- packages ----------------------------------------------------------------------
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    say "installing docker, compose, git, sqlite3"
    apt-get update -q
    DEBIAN_FRONTEND=noninteractive apt-get install -yq docker.io docker-compose-v2 docker-buildx git sqlite3 jq
    systemctl enable --now docker
fi
command -v aws >/dev/null || { say "installing the AWS CLI"; snap install aws-cli --classic; }

# Swap: a safety net against the OOM killer while the hot loop builds its index
# (or while an image builds). Not a substitute for enough RAM.
if [ ! -f /swapfile ]; then
    say "adding 4G swap"
    fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- code -----------------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
    say "updating $DIR ($BRANCH)"
    git -C "$DIR" fetch -q origin "$BRANCH"
    git -C "$DIR" checkout -q "$BRANCH"
    git -C "$DIR" pull -q --ff-only origin "$BRANCH"
else
    say "cloning $REPO_URL ($BRANCH)"
    git clone -q --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR"
git log -1 --format='    at %h %s (%cr)'

# --- secrets ------------------------------------------------------------------------
say "fetching .env from SSM $PARAM"
umask 077
aws ssm get-parameter --name "$PARAM" --with-decryption --query Parameter.Value --output text > .env.new
grep -q '^PRIVATE_KEY=' .env.new || { echo "the parameter has no PRIVATE_KEY line" >&2; rm -f .env.new; exit 1; }
mv .env.new .env
umask 022

# --- seed databases ---------------------------------------------------------------
mkdir -p db
for c in $CHAINS; do
    if [ ! -f "db/$c.sqlite" ]; then
        [ -n "${BUCKET:-}" ] || { echo "db/$c.sqlite missing and BUCKET not set" >&2; exit 1; }
        say "downloading $c databases from s3://$BUCKET/db/"
        aws s3 cp --only-show-errors "s3://$BUCKET/db/$c.sqlite" "db/$c.sqlite"
        aws s3 cp --only-show-errors "s3://$BUCKET/db/$c-liq.sqlite" "db/$c-liq.sqlite" 2>/dev/null \
            || echo "    (no $c-liq.sqlite in the bucket — the watcher will seed itself)"
        sqlite3 "db/$c.sqlite" 'PRAGMA quick_check;' | head -1 | grep -qx ok \
            || { echo "db/$c.sqlite failed quick_check — re-upload it" >&2; rm -f "db/$c.sqlite"; exit 1; }
    fi
done

# --- build + run --------------------------------------------------------------------
files=(-f compose.yaml)
[ "$CLOUDWATCH" = 1 ] && files+=(-f compose.aws.yaml)
say "building: $CHAINS"
# shellcheck disable=SC2086
docker compose "${files[@]}" build $CHAINS
say "starting: $CHAINS"
# shellcheck disable=SC2086
docker compose "${files[@]}" up -d $CHAINS
docker compose "${files[@]}" ps

cat <<EOF

Running. Mode per chain comes from MODE / <CHAIN>_MODE in .env (default test = simulate only).
  logs:     cd $DIR && sudo docker compose logs -f $CHAINS$( [ "$CLOUDWATCH" = 1 ] && printf '\n            (CloudWatch: aws logs tail arbitrade/<chain> --follow)' )
  memory:   sudo docker stats --no-stream
  stop:     cd $DIR && sudo docker compose stop
EOF
