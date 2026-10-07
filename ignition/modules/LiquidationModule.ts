import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys LiquidationExecutor (contracts/LiquidationExecutor.sol). No
// constructor arguments: the owner is the deployer, and every lender / Aave
// pool is passed per call, so one deployment serves every lending market on
// the chain. Use `yarn deploy-liquidator <chain>`, then `yarn contract-update
// <chain>` to write the address into conf/<chain>.json5 as `liquidator:`.
export default buildModule("LiquidationModule", (m) => {
  const liquidator = m.contract("LiquidationExecutor", []);
  return { liquidator };
});
