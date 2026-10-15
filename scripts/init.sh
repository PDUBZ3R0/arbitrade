#!/bin/bash

yarn deploy-all $1
export PARA_MZ="$@"

if [ -z "$(echo $PARA_MZ | grep \"--no-factories\")" ]; then
	if [ -z "$(echo $PARA_MZ | grep \"--all-factories\")" ]; then
		yarn factories $1 --add --add-assumed-fees --verify-limit 25
	else
		yarn factories $1 --add --add-assumed-fees --verify-all
	fi
fi

yarn scan $1 && \
	yarn check-fee-config $1 --apply && \
	yarn reserves $1 --blacklist-dead && \
	yarn verify-fees $1 --claude --apply --blacklist-unread && \
	yarn cleanup $1 --empty --yes --prune-conf && \
	yarn tokens $1 && \
	yarn probe $1 