#!/bin/bash

MKT=$1
shift 
if [[ ("$MKT" == "aave" || "$MKT" == "morpho") ]]; then 
	bash scripts/log.sh source $MKT-market $@
else 
	echo "usage: yarn market <aave|morpho> <chain> <0xPoolContract>"
fi