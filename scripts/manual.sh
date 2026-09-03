#!/bin/bash

yarn scan $1 && \
	yarn reserves $1 --dust 0.01 --blacklist-dead && \
	yarn cleanup $1 --yes && \
	yarn tokens $1 && \
	yarn triangles $1 && \
	yarn evaluate $1 --debug