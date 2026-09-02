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
const ownerArg = getStr('--owner');

const cfg = loadChainConfig(chainArg);

let signer: Wallet | undefined;
let ownerAddress: string;

if (process.env.PRIVATE_KEY) {
    const provider = new JsonRpcProvider(cfg.chain.host);
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
console.log('');

async function runPass(): Promise<void> {
    const result = await runOrchestratorPass(cfg, {
        candidatesPerPass,
        minProfitTokens,
        live,
        ownerAddress,
        signer,
    });

    console.log(`[${new Date().toISOString()}] Pass done in ${result.elapsedMs}ms — tried ${result.candidatesTried} candidate(s)`);
    for (const a of result.attempts) {
        const root = a.candidate.rootToken.slice(0, 10);
        if (!a.built) {
            console.log(`  #${a.candidate.triangleId} [${root}] — edge decayed on fresh reserves, skipped`);
        } else if (!a.simulated) {
            console.log(`  #${a.candidate.triangleId} [${root}] — simulation reverted: ${a.simulationError}`);
        } else if (a.broadcast) {
            console.log(`  #${a.candidate.triangleId} [${root}] — SIMULATED CLEAN, BROADCAST: ${a.txHash}`);
        } else {
            console.log(`  #${a.candidate.triangleId} [${root}] — simulated clean (dry run, not broadcast). ` +
                `Expected profit: ${a.built.expectedProfit} wei`);
        }
    }
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
