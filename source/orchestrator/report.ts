// -----------------------------------------------------------------------------
// Human-readable rendering of a CandidateAttempt.
//
// Shared by `yarn orchestrator` and `yarn hot` for the same reason the
// execution path itself is shared (see ./attempt.ts): both need to print the
// identical six outcomes, and a second copy drifts. The specific hazard here is
// not a crash but a lie — the realised-vs-estimated distinction below took
// deliberate work to get right, and a divergent copy would quietly report
// estimates as profit again.
// -----------------------------------------------------------------------------

import type { ChainConfig } from '../util/config.ts';
import type { CandidateAttempt } from './attempt.ts';

export function makeFormatters(cfg: ChainConfig) {
    const tokenMeta = (addr: string) => {
        const t = cfg.flashloan?.tokens.find(x => x.address.toLowerCase() === addr.toLowerCase());
        return { decimals: t?.decimals ?? 18, symbol: t?.symbol ?? addr.slice(0, 10) };
    };

    /** Display only — full precision is printed alongside in raw wei where it matters. */
    const fmtAmount = (wei: bigint, tokenAddr: string): string => {
        const { decimals, symbol } = tokenMeta(tokenAddr);
        return `${(Number(wei) / 10 ** decimals).toFixed(6)} ${symbol}`;
    };

    const fmtRoiPct = (profit: bigint, input: bigint): string => {
        if (input <= 0n) return 'n/a';
        // BigInt division first — these are wei-scale values and float
        // conversion first would lose the low digits that make up the ratio.
        const bps = (profit * 1_000_000n) / input;
        return `${(Number(bps) / 10_000).toFixed(4)}%`;
    };

    return { fmtAmount, fmtRoiPct, tokenMeta };
}

/**
 * Print one attempt, as one line plus detail. `log` is injectable so the hot
 * loop can prefix with a block number.
 */
export function printAttempt(
    cfg: ChainConfig,
    a: CandidateAttempt,
    log: (s: string) => void = console.log,
): void {
    const { fmtAmount, fmtRoiPct } = makeFormatters(cfg);
    const root = a.candidate.rootToken.slice(0, 10);
    const id = `#${a.candidate.triangleId} [${root}]`;

    if (!a.built) {
        log(`  ${id} — edge decayed on fresh reserves, skipped`);
        return;
    }

    if (a.belowGasFloor) {
        // Expected to be the common outcome on expensive chains: the edge is
        // real but smaller than the block space costs. Print both numbers so
        // it's obvious this is economics, not a bug.
        log(`  ${id} — profitable but does not cover gas, skipped`);
        log(`      est. profit=${fmtAmount(a.built.expectedProfit, a.candidate.rootToken)}  ` +
            `floor=${fmtAmount(a.minProfitUsed ?? 0n, a.candidate.rootToken)}  ` +
            `(gas ${a.gasEstimate ?? '?'} units` +
            (a.gasFloorWei != null ? `, ${fmtAmount(a.gasFloorWei, a.candidate.rootToken)} incl. margin` : ', unpriced') + `)`);
        return;
    }

    if (!a.simulated) {
        log(`  ${id} — simulation reverted: ${a.simulationError}`);
        if (a.built.inputClamped) {
            log(`      [!] input was clamped from ${a.built.requestedAmountIn} to ${a.built.rootAmountIn} wei ` +
                `(evaluator's off-chain size exceeded the safety fraction of live reserves — see build-hops.ts)`);
        }
        log(`      hops:`);
        for (const h of a.candidate.hops) {
            log(`        ${h.tokenIn.slice(0, 10)} → ${h.tokenOut.slice(0, 10)}  pair=${h.pair}  factory=${h.factory}`);
        }
        return;
    }

    if (a.confirmed) {
        // Print the REALISED profit (from the contract's ArbExecuted event),
        // not the pre-trade estimate. The estimate is an upper bound — reserve
        // drift and transfer taxes can only reduce what actually lands — so
        // labelling it "profit" overstates every confirmed trade. Show the
        // estimate alongside only when the two differ, since the gap is the
        // interesting part.
        const realised = a.realisedProfit ?? a.built.expectedProfit;
        const drifted = a.realisedProfit != null && a.realisedProfit !== a.built.expectedProfit;
        log(`  ${id} — CONFIRMED on-chain: ${a.txHash} (recorded to ledger)`);
        log(`      input=${fmtAmount(a.built.rootAmountIn, a.candidate.rootToken)}  ` +
            `profit=${fmtAmount(realised, a.candidate.rootToken)}  ROI=${fmtRoiPct(realised, a.built.rootAmountIn)}` +
            (drifted ? `  (estimated ${fmtAmount(a.built.expectedProfit, a.candidate.rootToken)} before drift/taxes)` : '') +
            (a.realisedProfit == null ? `  [!] estimate — no ArbExecuted event found` : ''));
        return;
    }

    if (a.broadcast) {
        log(`  ${id} — broadcast but reverted on-chain: ${a.txHash} (not recorded — see error below)`);
        log(`      ${a.simulationError}`);
        return;
    }

    log(`  ${id} — simulated clean (dry run, not broadcast).`);
    // "est." because the contract sizes each hop from live reserves at
    // execution time; this is what we predict at the reserves we just read, and
    // it is an upper bound on what a real trade would yield.
    log(`      input=${fmtAmount(a.built.rootAmountIn, a.candidate.rootToken)} (${a.built.rootAmountIn} wei)  ` +
        `est. profit=${fmtAmount(a.built.expectedProfit, a.candidate.rootToken)} (${a.built.expectedProfit} wei)  ` +
        `ROI=${fmtRoiPct(a.built.expectedProfit, a.built.rootAmountIn)}`);
    log(`      gas=${a.gasEstimate ?? '?'} units  ` +
        `floor=${fmtAmount(a.minProfitUsed ?? a.built.minProfitWei, a.candidate.rootToken)} enforced on-chain  ` +
        (a.gasFloorWei != null
            ? `(gas-derived; config floor was ${fmtAmount(a.built.minProfitWei, a.candidate.rootToken)})`
            : `(config floor — gas could not be priced in this root)`));
    if (a.built.inputClamped) {
        log(`      [!] input was clamped from ${a.built.requestedAmountIn} to ${a.built.rootAmountIn} wei ` +
            `(evaluator's off-chain size exceeded the safety fraction of live reserves)`);
    }
}
