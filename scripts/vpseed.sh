#!/bin/bash

CHAIN="$1"
if [ -z "$CHAIN" ]; then
	echo "chain required."
	exit 1
fi
bash -c "scp db/${CHAIN}*.sqlite arb:/opt/arbitrade/db/"

# compose.yaml reads env_file: .env in /opt/arbitrade, not dist/.env. This used
# to copy to /opt/arbitrade/dist/, so the containers never got the private
# <LABEL>_RPC fallbacks. Polygon's liquidator then sat on block 97,483,952 for
# days (2026-11-21): no public endpoint serves 5,000-block getLogs that deep,
# and there was no private endpoint to fall back to.
#
# Merge rather than overwrite. The VPS .env holds keys this file lacks
# (ETHERSCAN_API_KEY), and existing values win. Lines pointing at localhost
# (ENVIO_REST_URL is the dev box's indexer) are skipped, because nothing on
# the VPS listens there.
scp "dist/vps/.env" arb:/opt/arbitrade/.env.incoming
# The tail check adds a newline when .env lacks one. Without it, the first merge
# (2026-11-21) appended PLASMA_RPC onto the end of the ENVIO_API_TOKEN line.
ssh arb 'cd /opt/arbitrade && cp .env ".env.bak-$(date +%Y%m%d%H%M%S)" &&
	{ [ -z "$(tail -c1 .env)" ] || echo >> .env; } &&
	added=0 &&
	while IFS= read -r line || [ -n "$line" ]; do
		k=${line%%=*}
		case "$k" in ""|\#*) continue;; esac
		case "$line" in *localhost*|*127.0.0.1*) continue;; esac
		grep -q "^$k=" .env || { printf "%s\n" "$line" >> .env; added=$((added+1)); }
	done < .env.incoming &&
	rm .env.incoming &&
	echo "merged $added new key(s) into /opt/arbitrade/.env; restart containers to pick them up"'
