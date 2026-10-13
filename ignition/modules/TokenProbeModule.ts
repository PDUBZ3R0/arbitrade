import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys TokenProbe (honeypot / fee-on-transfer / restricted-pair detector)
// with the chain's Aave V3 Pool address (address(0) where there is none —
// probeFrom() then borrows from the conf's lender: Balancer, a V3 pool, or
// Morpho Blue / Longbow; only the legacy probe() needs the Aave pool). TokenProbe never completes a call —
// it always reverts with its measurements and is only ever used via eth_call —
// so it can't hold or move funds. See contracts/TokenProbe.sol.
//
// scripts/deploy.sh (probe) reuses the aavePool already in
// ignition/parameters/<chain>.json (under FlashArbModule), so there's no
// second copy of the address to keep in sync. No default: the wrong chain's
// pool would make every probe fail.
export default buildModule("TokenProbeModule", (m) => {
  const aavePool = m.getParameter<string>("aavePool");
  const probe = m.contract("TokenProbe", [aavePool]);
  return { probe };
});
