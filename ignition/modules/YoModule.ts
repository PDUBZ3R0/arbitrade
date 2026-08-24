import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("YoModule", (m) => {
  const batches = m.contract("YoBatches");
  return { batches };
});