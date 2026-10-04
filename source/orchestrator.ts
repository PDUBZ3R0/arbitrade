// -----------------------------------------------------------------------------
// CLI: yarn orchestrator <chain> [options]
//
// Runs the orchestrator (piece 6): evaluate → refresh reserves → simulate →
// (optionally) broadcast. Default is a SINGLE dry-run pass — safe, no funds
// at risk, no tx sent. Add --live to actually broadcast a clean simulation,
// and --loop to run continuously instead of exiting after one pass.
// -----------------------------------------------------------------------------

import { Wallet, JsonRpcProvider } from 'ethers';
import { loadChainConfig } from './util/config.ts';
import { runOrchestratorPass } from './orchestrator/loop.ts';
import { printAttempt } from './orchestrator/report.ts';
import { DEFAULT_MAX_ROI_PCT } from './evaluator/evaluator.ts';
import { makeProvider } from './util/rpc.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn orchestrator <chain> [options]');
    console.error('');
    console.error('  --live                   Broadcast the first candidate that simulates clean.');
    console.error('                           Without this flag, the orchestrator only simulates —');
    console.error('                           no transaction is ever sent. Requires PRIVATE_KEY env var.');
    console.error('  --loop                   Run continuously instead of exiting after one pass.');
    console.error('  --interval-ms N          Delay between passes in --loop mode (default 5000).');
    console.error('  --candidates N           Candidates to try per pass (default 5).');
    console.error('  --min-profit-tokens N    Minimum profit as fraction of root token (default 0.001).');
    console.error(`  --max-roi-pct N          Skip candidates with off-chain ROI above N% (default ${DEFAULT_MAX_ROI_PCT}).`);
    console.error('  --gas-margin N           Require profit >= N x the measured gas cost (default 3).');
    console.error('                           Gas is measured per candidate via eth_estimateGas at the');
    console.error('                           live gas price, so this floor tracks the chain rather than');
    console.error('                           relying on a static config number. 1 = break-even.');
    console.error('                           Real arb rarely exceeds a few percent — this is a sanity');
    console.error('                           bound against evaluator math phantoms, same default as');
    console.error('                           `yarn evaluate`.');
    console.error('  --owner ADDR             Address to simulate/sign from. Defaults to the address');
    console.error('                           derived from PRIVATE_KEY if set, otherwise required.');
    console.error('');
    console.error('Requires an executor deployed first: yarn deploy-flasharb <chain>,');
    console.error('then set "executor": "0x..." under the chain block in conf/<chain>.json5.');
    process.exit(1);
}

const getStr = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => args.indexOf(flag) >= 0;

const live = hasFlag('--live');
const loop = hasFlag('--loop');
const intervalMsStr = getStr('--interval-ms');
const intervalMs = intervalMsStr ? parseInt(intervalMsStr, 10) : 5000;
const candidatesStr = getStr('--candidates');
const candidatesPerPass = candidatesStr ? parseInt(candidatesStr, 10) : 5;
const minProfitTokensStr = getStr('--min-profit-tokens');
const minProfitTokens = minProfitTokensStr ? parseFloat(minProfitTokensStr) : undefined;
const maxRoiPctStr = getStr('--max-roi-pct');
const maxRoiPct = maxRoiPctStr ? parseFloat(maxRoiPctStr) : undefined;
const gasMarginStr = getStr('--gas-margin');
const gasMarginMultiple = gasMarginStr ? parseFloat(gasMarginStr) : undefined;
if (gasMarginStr && !(Number.isFinite(gasMarginMultiple) && (gasMarginMultiple as number) > 0)) {
    console.error(`--gas-margin must be a positive number, got "${gasMarginStr}"`);
    process.exit(1);
}
const ownerArg = getStr('--owner');

const cfg = loadChainConfig(chainArg);

let signer: Wallet | undefined;
let ownerAddress: string;

if (process.env.PRIVATE_KEY) {
    const provider = makeProvider(cfg.chain);
    signer = new Wallet(process.env.PRIVATE_KEY, provider);
    ownerAddress = ownerArg ?? signer.address;
} else if (ownerArg) {
    ownerAddress = ownerArg;
} else {
    console.error('No PRIVATE_KEY env var and no --owner given. Need an address to simulate from');
    console.error('(and a signer if --live is set). Set PRIVATE_KEY in .env, or pass --owner 0x...');
    console.error('for dry-run-only simulation against a specific owner address.');
    process.exit(1);
}

if (live && !signer) {
    console.error('--live requires PRIVATE_KEY to be set (need a signer to broadcast).');
    process.exit(1);
}

console.log(`Orchestrator for ${cfg.chain.name} (chain id ${cfg.chain.id})`);
console.log(`Executor: ${cfg.chain.executor ?? '(not set — will error)'}`);
console.log(`Mode: ${live ? 'LIVE — will broadcast clean simulations' : 'DRY RUN — simulate only, no broadcast'}`);
console.log(`Owner/simulate-from: ${ownerAddress}`);
console.log(`Candidates per pass: ${candidatesPerPass}`);
console.log(`Max ROI cap: ${maxRoiPct ?? DEFAULT_MAX_ROI_PCT}%`);
console.log(`Gas margin:  ${gasMarginMultiple ?? 3}x measured gas (profit floor is raised to cover it)`);
console.log('');

async function runPass(): Promise<void> {
    const result = await runOrchestratorPass(cfg, {
        candidatesPerPass,
        minProfitTokens,
        maxRoiPct,
        gasMarginMultiple,
        live,
        ownerAddress,
        signer,
    });

    console.log(`[${new Date().toISOString()}] Pass done in ${result.elapsedMs}ms — tried ${result.candidatesTried} candidate(s)`);

    // Rendering lives in ./orchestrator/report.ts so `yarn hot` prints the
    // identical six outcomes from the identical code. The realised-vs-estimated
    // distinction in particular is too easy to get wrong twice.
    for (const a of result.attempts) printAttempt(cfg, a);

    if (!result.winner) {
        console.log('  No candidate simulated clean this pass.');
    }
}

if (loop) {
    console.log(`Looping every ${intervalMs}ms. Ctrl+C to stop.\n`);
    while (true) {
        try {
            await runPass();
        } catch (err) {
            console.error(`[!] Pass failed: ${(err as Error).message}`);
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
} else {
    await runPass();
}
