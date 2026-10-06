#!/bin/bash

CHAIN=$1
CMD=$2

yarn manual $CHAIN
if [[ "$CMD" == "test" ]]; then
	yarn hot $CHAIN --gas-margin 1.5 --candidates 20
else
	yarn hot $CHAIN --gas-margin 1.5 --candidates 20 --live
fi