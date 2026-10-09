#!/bin/bash

CHAIN=$1

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn all <chain> [hot-args]" >&2
    exit 1
fi

HOTS="$@"
if [ -z "$HOTS" ]; then
	HOTS="--gas-margin 1.5 --candidates 20"
fi

yarn manual $CHAIN
yarn hot $CHAIN "${HOTS[@]}"
