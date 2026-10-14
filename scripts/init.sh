#!/bin/bash

yarn deploy-all $1 && \
	yarn factories $1 --add --add-assumed-fees --verify-all && \
	yarn scan $1 && \
	yarn check-fee-config $1 --apply && \
	yarn reserves $1 --blacklist-dead && \
	yarn verify-fees $1 --claude --apply --blacklist-unread && \
	yarn cleanup $1 --empty --yes --prune-conf && \
	yarn tokens $1 && \
	yarn probe $1 