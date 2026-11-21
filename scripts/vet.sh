#!/bin/bash

CMD=$1
CHAIN=$2
shift 2


CHAIN_ID=$(node ./source/util/chainid.ts $CHAIN 2>/dev/null)

echo "Chain: \"$CHAIN\", ID: [$CHAIN_ID]"

if [ -z "$CHAIN_ID" ]; then 
	echo "Chain unknown, run: yarn add-chain <id#> (or use id number)"
else 
	mkdir -p ./log/$CHAIN/
	yarn vetrpc $CMD $CHAIN_ID --out ./conf/provider/ $@ 2>&1 | tee ./log/$CHAIN/provider.log
fi
