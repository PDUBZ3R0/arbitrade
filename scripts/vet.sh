#!/bin/bash

CHAIN=$1
shift

CHAIN_ID=$(node --input-type=module -e "
import JSON5 from 'json5'; import { readFileSync } from 'node:fs';
if (/^\d+$/.test('$CHAIN')){
	process.stdout.write('$CHAIN');
} else {
	const c = JSON5.parse(readFileSync('conf/@chains.json5', 'utf8'));
	if (c['$CHAIN']?.id) process.stdout.write(String(c['$CHAIN']?.id));
}" 2>/dev/null)

echo "Chain: \"$CHAIN\", ID: [$CHAIN_ID]"

if [ -z "$CHAIN_ID" ]; then 
	echo "Chain unknown, run: yarn add-chain <id#> (or use id number)"
else 
	mkdir -p ./log/$CHAIN/
	yarn vetrpc vet $CHAIN_ID --out ./conf/provider/ $@ 2>&1 | tee ./log/$CHAIN/provider.log
fi
