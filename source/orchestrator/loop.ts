// -----------------------------------------------------------------------------
// Orchestrator loop (piece 6, final assembly).
//
// One pass:
//   1. Run the evaluator (piece 5) fresh — candidates, off-chain float math
//   2. For each candidate (best first), hand it to CandidateExecutor, which
//      refreshes reserves, recomputes the path with BigInt math, measures gas,
//      raises the profit floor to cover it, eth_call-simulates executeArb and
//      (with --live) broadcasts. Aave's flashLoanSimple calls back into
//      executeOperation synchronously within the same call, so a successful
//      eth_call means the WHOLE chain — borrow, every swap, repay — would
//      succeed on-chain right now.
//
// The per-candidate sequence lives in ./attempt.ts because the Sync-driven hot
// loop (source/hot.ts) needs exactly the same one from a completely different
// candidate source. See that module's header for why it is shared rather than
// copied.
//
// Deliberately does NOT try every candidate — stops at the first one that
// simulates clean (or, in --live mode, the first one that lands), since
// candidates share pairs and executing one likely invalidates the others'
// reserves anyway.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, type Signer } from 'ethers';
import type { ChainConfig } from '../util/config.ts';
import { ArbitradeDB } from '../util/db.ts';
import { dbPath } from '../util/config.ts';
import { evaluateTriangles, DEFAULT_MAX_ROI_PCT } from '../evaluator/evaluator.ts';
import { CandidateExecutor, type CandidateAttempt } from './attempt.ts';
import { AttemptFilter } from './select.ts';
import { makeProvider } from '../util/rpc.ts';

export type { CandidateAttempt } from './attempt.ts';

export type OrchestratorPassOptions = {
    /** How many top candidates (by evaluator's float-math ranking) to try per pass. Default 5. */
    candidatesPerPass?: number;
    /** Minimum profit as fraction of root token — same meaning as evaluator's minProfitTokens. Default 0.001. */
    minProfitTokens?: number;
    /**
     * Dust-liquidity floor and minimum input, same meaning as the evaluator's
     * options of the same names. Default to the chain config's `evaluator`
     * block so a pass sees the same candidate set `yarn evaluate` does.
     */
    minLiquidityTokens?: number;
    minInputTokens?: number;
    /**
     * Safety multiple applied to the measured gas cost when deriving the
     * on-chain profit floor. See ExecutorOptions.gasMarginMultiple. Default 3.
     */
    gasMarginMultiple?: number;
    /**
     * Skip candidates whose off-chain-estimated ROI exceeds this percentage.
     * Defaults to DEFAULT_MAX_ROI_PCT, imported from the evaluator — see that
     * constant for why it is wide open and for the two separate times this
     * default diverged between here and the CLI.
     */
    maxRoiPct?: number;
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

export type OrchestratorPassResult = {
    candidatesTried: number;
    /** Candidates passed over because a pair of theirs already failed. See ./select.ts. */
    skippedSharingFailedPair: number;
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

    // Validate BEFORE the evaluator runs. CandidateExecutor's constructor
    // checks the same two things, but it is built after evaluateTriangles, and
    // that pass takes 10-60s — long enough that learning "no executor
    // deployed" at the end of it is a bad trade for the reader.
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

    const provider = makeProvider(cfg.chain);
    const dbFile = dbPath(cfg.chain.label);
    const db = new ArbitradeDB(dbFile);

    const candidatesPerPass = opts.candidatesPerPass ?? 5;
    // Chain-tuned default from conf/<chain>.json5's `evaluator` block (same
    // source the evaluate.ts CLI uses), falling back to 0.001 if the chain
    // hasn't set one. Keeps the orchestrator's profit floor consistent with
    // whatever you've calibrated for manual `yarn evaluate` runs, rather than
    // silently using its own separate hardcoded number.
    const minProfitTokens = opts.minProfitTokens ?? cfg.evaluator?.minProfitTokens ?? 0.001;
    // One shared constant, not a local literal — this is the line that
    // previously said 20 while the CLI banner said 2000.
    const maxRoiPct = opts.maxRoiPct ?? DEFAULT_MAX_ROI_PCT;
    // Same story as minProfitTokens, and the same bug twice over: these two
    // were simply not passed through, so the orchestrator evaluated with the
    // library defaults while `yarn evaluate` used the chain config. On Polygon
    // that meant the orchestrator scored ~4.3M triangles and kept 278,977
    // candidates where evaluate scored 174,487 and kept 30,935 — 25x the work
    // per pass, and ~248k dust candidates competing for the top-5 slots that
    // get simulated. Ranking is by profit, so dust can outrank real edges.
    const minLiquidityTokens = opts.minLiquidityTokens ?? cfg.evaluator?.minLiquidityTokens;
    const minInputTokens = opts.minInputTokens ?? cfg.evaluator?.minInputTokens;

    const result: OrchestratorPassResult = {
        candidatesTried: 0,
        skippedSharingFailedPair: 0,
        attempts: [],
        winner: null,
        elapsedMs: 0,
    };

    try {
        // Pricing arrives with the evaluation below; the executor is built
        // first only to ask whether the deployed contract can trade V3 hops.
        const executor = new CandidateExecutor(cfg, provider, {}, {
            ownerAddress: opts.ownerAddress,
            live: opts.live,
            signer: opts.signer,
            gasMarginMultiple: opts.gasMarginMultiple,
            minProfitTokens,
        });

        const evalResult = await evaluateTriangles(cfg, dbFile, {
            limit: candidatesPerPass,
            minProfitTokens,
            maxRoiPct,
            // Cycles with a v3 hop compete for the attempt slots only when the
            // executor has the V3 swap path (HOP_V3); an older deployment gets
            // V2-only cycles, as before.
            executableOnly: !(await executor.supportsV3()),
            minLiquidityTokens,
            minInputTokens,
        });
        executor.setRootPricing(evalResult.rootPricing);

        // See ./select.ts: without this, a pass can spend every attempt on
        // permutations of one broken cycle.
        const filter = new AttemptFilter();

        for (const candidate of evalResult.topCandidates) {
            const blocked = filter.blockedBy(candidate);
            if (blocked) {
                result.skippedSharingFailedPair++;
                console.log(`  #${candidate.triangleId} — skipped: routes through ${blocked}, which already failed this pass`);
                continue;
            }

            result.candidatesTried++;
            const attempt = await executor.attempt(candidate, db);
            result.attempts.push(attempt);
            if (!attempt.simulated) {
                // Decayed, would revert, or below the gas floor. Either way
                // these pairs just refused us; don't pay to find out twice.
                filter.noteFailure(candidate);
                continue;
            }
            // A live broadcast that reverted on-chain still ends the pass. It
            // is tempting to fall through to the next candidate — but gas has
            // already been spent, the revert means the book moved under us, and
            // the remaining candidates share pairs with this one, so they are
            // priced off reserves we now know are stale. Retrying immediately
            // is how you pay for several reverts in one block.
            result.winner = attempt;
            break; // stop at first clean candidate — see module docstring
        }
    } finally {
        db.close();
        provider.destroy();
    }

    result.elapsedMs = Date.now() - t0;
    return result;
}
