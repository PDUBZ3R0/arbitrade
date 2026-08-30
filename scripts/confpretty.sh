#!/bin/bash

FNM=conf/$1.json5

cat $FNM | node -e "import JSON5 from 'json5'; process.stdin.on('data', d => console.log(JSON5.stringify(JSON5.parse(d), null, 2)))" | tee $FNM

