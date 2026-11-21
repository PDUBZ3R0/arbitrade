#!/bin/bash

CHAIN=$1
CHAIN_ID=$(node ./source/util/chainid.ts $CHAIN 2>/dev/null)
if [ ! -f "./conf/provider/$CHAIN_ID.json" ]; then
	yarn provider $CHAIN_ID
fi

yarn deploy all $CHAIN
export PARA_MZ="$@"

if [ -z "$(echo $PARA_MZ | grep -e '--no-factories')" ]; then
	if [ -z "$(echo $PARA_MZ | grep -e '--all-factories')" ]; then
		yarn factories $CHAIN --add --add-assumed-fees --verify-limit 25
	else
		yarn factories $CHAIN --add --add-assumed-fees --verify-all
	fi
fi

yarn scan $CHAIN --transport envio && \
	yarn reserves $CHAIN --blacklist-dead && \
	yarn cleanup $CHAIN --empty --yes --prune-conf && \
	yarn tokens $CHAIN && \
	yarn probe $CHAIN 