#!/bin/bash

CHAIN="$1"
if [ -z "$CHAIN" ]; then
	echo "chain required."
	exit 1
fi
scp "db/${CHAIN}*.sqlite" arb:/opt/arbitrade/db/
scp "dist/vps/.env" arb:/opt/arbitrade/dist/