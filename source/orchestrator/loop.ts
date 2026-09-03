// -----------------------------------------------------------------------------
// Orchestrator loop (piece 6, final assembly).
//
// One pass:
//   1. Run the evaluator (piece 5) fresh — candidates, off-chain float math
//   2. For each candidate (best first): buildHops() refreshes reserves and
//      recomputes the exact path with BigInt math (source/orchestrator/build-hops.ts)
//   3. eth_call-simulate executeArb() against the deployed FlashArbExecutor.
//      Aave's flashLoanSimple calls back into executeOperation synchronously
//      within the same call, so a successful eth_call here means the WHOLE
//      chain — borrow, every swap, repay — would succeed on-chain right now.
//   4. Dry-run (default): log the simulation result, don't broadcast.
//      --live: sign and send the transaction that just simulated clean.
//
// Deliberately does NOT try every candidate — stops at the first one that
// simulates clean (or, in --live mode, the first one that lands), since
// candidates share pairs and executing one likely invalidates the others'
// reserves anyway.
// -----------------------------------------------------------------------------

import { Contract, JsonRpcProvider, Wallet, type Signer } from 'ethers';
import type { ChainConfig } from '../util/config.ts';
import { ArbitradeDB } from '../util/db.ts';
import { dbPath } from '../util/config.ts';
import { evaluateTriangles, type Candidate } from '../evaluator/evaluator.ts';
import { buildHops, type BuiltArb } from './build-hops.ts';

const EXECUTOR_ABI = [
    'function executeArb(address asset, uint256 amount, (address pair, uint256 amount0Out, uint256 amount1Out, address recipient)[] hops) external',
];

export type OrchestratorPassOptions = {
    /** How many top candidates (by evaluator's float-math ranking) to try per pass. Default 5. */
    candidatesPerPass?: number;
    /** Minimum profit as fraction of root token — same meaning as evaluator's minProfitTokens. Default 0.001. */
    minProfitTokens?: number;
    /** If true, broadcast the first candidate that simulates clean. Default false (dry-run/simulate only). */
    live?: boolean;
    /**
     * Address to simulate `from`. executeArb is onlyOwner, so eth_call needs
     * this to match the deployed contract's owner or it reverts on the
     * access-control check before we even learn if the trade itself works.
     * Required for both dry-run and live (live also needs a matching signer).
     */
    ownerAddress: string;
    /** Required when live=true — must control ownerAddress. */
    signer?: Signer;
};

export type CandidateAttempt = {
    candidate: Candidate;
    built: BuiltArb | null;
    simulated: boolean;
    simulationError?: string;
    broadcast: boolean;
    txHash?: string;
};

export type OrchestratorPassResult = {
    candidatesTried: number;
    attempts: CandidateAttempt[];
    /** The attempt that simulated clean (and was broadcast, if live) — or null if none did. */
    winner: CandidateAttempt | null;
    elapsedMs: number;
};

/**
 * Run one orchestrator pass for a chain: evaluate → build → simulate →
 * (optionally) broadcast. Stops at the first candidate that simulates clean.
 */
export async function runOrchestratorPass(
    cfg: ChainConfig,
    opts: OrchestratorPassOptions,
): Promise<OrchestratorPassResult> {
    const t0 = Date.now();

    if (!cfg.chain.executor) {
        throw new Error(
            `No executor deployed for ${cfg.chain.name} (chain.executor is unset in config). ` +
            `Run \`yarn deploy-flasharb ${cfg.chain.label}\` first, then add the deployed address ` +
            `as "executor" under the chain block in conf/${cfg.chain.label}.json5.`
        );
    }
    if (opts.live && !opts.signer) {
        throw new Error('live=true requires a signer (set PRIVATE_KEY and pass a Wallet).');
    }

    const provider = new JsonRpcProvider(cfg.chain.host);
    const dbFile = dbPath(cfg.chain.label);
    const db = new ArbitradeDB(dbFile);

    const candidatesPerPass = opts.candidatesPerPass ?? 5;
    // Chain-tuned default from conf/<chain>.json5's `evaluator` block (same
    // source the evaluate.ts CLI uses), falling back to 0.001 if the chain
    // hasn't set one. Keeps the orchestrator's profit floor consistent with
    // whatever you've calibrated for manual `yarn evaluate` runs, rather
    // than silently using its own separate hardcoded number.
    const minProfitTokens = opts.minProfitTokens ?? cfg.evaluator?.minProfitTokens ?? 0.001;

    const result: OrchestratorPassResult = {
        candidatesTried: 0,
        attempts: [],
        winner: null,
        elapsedMs: 0,
    };

    try {
        const evalResult = await evaluateTriangles(cfg, dbFile, {
            limit: candidatesPerPass,
            minProfitTokens,
        });

        // Per-root-token minProfitWei, using the SAME resolved threshold the
        // evaluator just used to select these candidates (evalResult.rootPricing
        // — numeraire-converted per root, not a flat fraction recomputed here).
        // Recomputing independently would silently diverge from what actually
        // selected the candidate the moment the evaluator's pricing logic
        // changes; reading it back from the result keeps them locked together.
        const minProfitWeiFor = (root: string): bigint => {
            const tokenCfg = cfg.flashloan?.tokens.find(t => t.address.toLowerCase() === root.toLowerCase());
            const decimals = tokenCfg?.decimals ?? 18;
            const pricing = evalResult.rootPricing[root.toLowerCase()];
            const rootUnits = pricing?.minProfitInRootTokens ?? minProfitTokens;
            return BigInt(Math.round(rootUnits * 10 ** decimals));
        };

        const executor = new Contract(cfg.chain.executor, EXECUTOR_ABI, provider);

        for (const candidate of evalResult.topCandidates) {
            result.candidatesTried++;
            const attempt: CandidateAttempt = { candidate, built: null, simulated: false, broadcast: false };
            result.attempts.push(attempt);

            const built = await buildHops(
                provider,
                cfg.chain.executor,
                db,
                candidate,
                minProfitWeiFor(candidate.rootToken),
            );
            attempt.built = built;
            if (!built) continue; // edge decayed since evaluation — try next candidate

            const hopsArg = built.hops.map(h => [h.pair, h.amount0Out, h.amount1Out, h.recipient]);

            try {
                await executor.executeArb.staticCall(
                    candidate.rootToken,
                    built.rootAmountIn,
                    hopsArg,
                    { from: opts.ownerAddress },
                );
                attempt.simulated = true;
            } catch (err) {
                attempt.simulationError = (err as Error).message?.slice(0, 300) ?? String(err);
                continue; // this candidate would revert on-chain — try next
            }

            if (opts.live) {
                const signedExecutor = executor.connect(opts.signer!) as Contract;
                const tx = await signedExecutor.executeArb(candidate.rootToken, built.rootAmountIn, hopsArg);
                attempt.broadcast = true;
                attempt.txHash = tx.hash;
            }

            result.winner = attempt;
            break; // stop at first clean candidate — see module docstring
        }
    } finally {
        db.close();
    }

    result.elapsedMs = Date.now() - t0;
    return result;
}
