import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Batch reader for the reserves stage: getReserves (V2-style balances) and
// getV3State (concentrated-liquidity pools). Replaces the original YoBatches.
//
// New module id ("Yo2Module") on purpose. The old "YoModule" journals in
// ignition/deployments/chain-*/ record a YoBatches deployment; reusing that id
// with a different contract would make ignition try to reconcile the two.
// A fresh id deploys cleanly next to them. After deploying, copy the new
// address into chain.contract in conf/<chain>.json5.
export default buildModule("Yo2Module", (m) => {
  const batches = m.contract("YoBatches2");
  return { batches };
});
