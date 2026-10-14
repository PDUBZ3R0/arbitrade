#!/bin/bash

yarn scan $1 && \
	yarn reserves $1 --blacklist-dead && \
	yarn cleanup $1 --empty --yes && \
	yarn tokens $1 && \
	yarn probe $1 --blacklist-restricted && \
	yarn triangles $1 && \
	yarn evaluate $1 --verbose