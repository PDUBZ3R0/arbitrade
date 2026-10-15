#!/bin/bash

FNM=conf/markets/$2.json
CMD=$1

if [[ "$CMD" == "commit" ]]; then
	cat $FNM | node -e "process.stdin.on('data', d => console.log(JSON.stringify(JSON.parse(d), null, 2)))" | tee $FNM
else
	cat $FNM | node -e "process.stdin.on('data', d => console.log(JSON.stringify(JSON.parse(d), null, 2)))"
fi