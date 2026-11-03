#!/bin/bash

CHAIN="$1"
if [ -z "$CHAIN" ]; then
	echo "chain required."
	exit 1
fi
ssh arb "docker logs arbitrade-${CHAIN}-1 -f" | tee log/$CHAIN/vps.log