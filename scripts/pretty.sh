#!/bin/bash

FNM=conf/$2.json5
CMD=$1

if [[ "$CMD" == "commit" ]]; then
	cat $FNM | node -e "import JSON5 from 'json5'; process.stdin.on('data', d => console.log(JSON5.stringify(JSON5.parse(d), null, 2)))" | tee $FNM
else
	cat $FNM | node -e "import JSON5 from 'json5'; process.stdin.on('data', d => console.log(JSON5.stringify(JSON5.parse(d), null, 2)))"
fi