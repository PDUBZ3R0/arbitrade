#!/bin/bash
# Deploy YoBatches3, FlashArbExecutor and TokenProbe to a chain, then copy
# their addresses from Ignition's record into conf/<chain>.json5.
#
# Usage: yarn deploy-all <chain>
#
# Paths are from the project root (where yarn runs scripts), not from scripts/.
# Stops at the first failed deploy. Re-running is safe: Ignition resumes from
# ignition/deployments/chain-<id>, re-checks any transaction it already sent,
# and skips what is already deployed. (deploy-flasharb is run WITHOUT
# --redeploy: wiping a future whose transaction is still pending orphans it.)

CHAIN="$1"
if [ -z "$CHAIN" ]; then
    echo "Usage: yarn deploy-all <chain>" >&2
    exit 1
fi

for step in deploy-contract deploy-flasharb deploy-probe; do
    if ! bash "scripts/${step}.sh" "$CHAIN"; then
        echo "" >&2
        echo "[deploy-all] ${step} failed — stopping; conf/${CHAIN}.json5 not updated." >&2
        echo "             Fix the cause (log/${CHAIN}/${step}.log) and re-run; finished steps are skipped." >&2
        exit 1
    fi
done

sh scripts/log.sh source/util contract-update "$CHAIN"
