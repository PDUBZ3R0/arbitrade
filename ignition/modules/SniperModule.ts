import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys SniperExecutor for ~/Development/sniper's real trades (yarn live with
// live.trade on). Its owner is sniper's hot wallet, NOT the deployer: only the
// owner can trade or withdraw, so the deployer (arbitrade's PRIVATE_KEY) never
// controls sniper's funds. scripts/deploy.sh (sniper) takes the address from
// SNIPER_OWNER or ignition/parameters/<chain>.json (SniperModule.owner). An
// address is not a secret; the key stays in sniper's .env.
export default buildModule("SniperModule", (m) => {
  const owner = m.getParameter<string>("owner");
  const sniper = m.contract("SniperExecutor", [owner]);
  return { sniper };
});
