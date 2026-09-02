import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys FlashArbExecutor with the chain's Aave V3 Pool address as the
// constructor arg. Pass it at deploy time:
//
//   yarn hardhat ignition deploy ignition/modules/FlashArbModule.ts \
//     --network base --parameters '{"FlashArbModule":{"aavePool":"0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"}}'
//
// or via a parameters JSON file (see hardhat ignition docs) if you'd rather
// not put the address on the command line. There's no safe default here —
// deploying with the wrong chain's pool address silently breaks flash loans,
// so this deliberately has no fallback value.
export default buildModule("FlashArbModule", (m) => {
  const aavePool = m.getParameter<string>("aavePool");
  const executor = m.contract("FlashArbExecutor", [aavePool]);
  return { executor };
});
