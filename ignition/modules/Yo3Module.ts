import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// YoBatches3: YoBatches2 plus packed reads (getReservesPacked,
// getReservesByPool, getV3StatePacked) that move a quarter to a third of the
// bytes. The client switches to them automatically when chain.contract has
// them, so this is a drop-in replacement for a YoBatches2 address.
//
// Own module id ("Yo3Module") for the same reason Yo2Module had one: the
// existing journals record other contracts under the older ids. After
// deploying, copy the Yo3Module#YoBatches3 address into chain.contract in
// conf/<chain>.json5.
export default buildModule("Yo3Module", (m) => {
  const batches = m.contract("YoBatches3");
  return { batches };
});
