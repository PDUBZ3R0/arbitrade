#!/bin/bash

CHAIN=$2

if [ -z "$CHAIN" ]; then
    echo "Usage: yarn all <test|live> <chain> [hot-args]" >&2
    exit 1
fi

CMD=$1
shift
shift

HOTS="$@"
if [ -z "$HOTS" ]; then
	HOTS="--gas-margin 1.5 --candidates 20"
fi

if [[ "$CMD" == "test" ]]; then
	HOT_ARGS="$HOTS"
elif [[ "$CMD" == "live" ]]; then
	HOT_ARGS="$HOTS --live"
else
    echo "Usage: yarn all <test|live> <chain> [hot-args]" >&2
    echo "you must specify test or live as 1st param"
    exit 1
fi

yarn manual $CHAIN
yarn hot $CHAIN "${HOT_ARGS[@]}"
