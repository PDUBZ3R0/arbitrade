// -----------------------------------------------------------------------------
// Hop builder (piece 6).
//
// Turns an evaluator Candidate (piece 5 output — an ordered list of pairs
// forming a cycle, scored with off-chain float math) into the Hop[] that
// FlashArbExecutor.executeArb takes.
//
// WHAT CHANGED, AND WHY IT MATTERS
//
// This module used to compute each hop's exact amount0Out/amount1Out and hand
// those to the contract, which passed them straight to pair.swap(). That made
// the whole transaction a bet that reserves would not move between this
// multicall and the mined transaction — because if they did, the pair's K
// invariant rejected the now-too-large output and reverted everything. On a
// 2-second chain against actively traded pairs, losing that bet is the normal
// case, and the cost is gas for nothing.
//
// The contract now sizes every hop itself, from live reserves and the amount
// that actually arrived at each pair. So the amounts computed here are no
// longer an instruction — they are a PREDICTION, used for two things only:
//
//   1. deciding whether the candidate is still worth broadcasting at fresh
//      reserves, and
//   2. reporting an expected profit for the log and the ledger.
//
// Being wrong about them costs a missed opportunity or an over-optimistic log
// line, never a reverted trade. The real guard is `minProfit`, which travels
// to the contract and is enforced on-chain against the actual closing balance.
//
// The prediction is bit-exact rather than approximate: feePpm is computed once
// here and used both for this BigInt walk and by the contract, at the same 1e6
// scale, so absent drift and transfer taxes the two agree exactly. With drift
// or a taxed token the contract necessarily produces less — this prediction is
// an upper bound, which is the correct direction for a go/no-go gate.
//
// Still re-derived here: reserves, via one atomic Multicall3 batch (single
// block, so every pair's reserve is mutually consistent).
// Still NOT re-derived: fees. Already resolved per-pair by the reserves
// fetcher's metadata step (pairs.fee in the DB, including the mutable `degen`
// flag for Retro-degen factories) and carried through the evaluator's
// resolveFee(). Fees are quasi-static; reserves move every block.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';
import type { ArbitradeDB } from '../util/db.ts';
import { multicall3, type Multicall3Call } from '../util/multicall.ts';
import type { Candidate } from '../evaluator/evaluator.ts';

/**
 * Matches FlashArbExecutor.Hop exactly. Note what is absent: output amounts.
 * The contract derives the swap direction from pair.token0() rather than
 * taking it from us, so there is no field here that can disagree with chain
 * state.
 */
export type Hop = {
    pair: string;
    /** Token sent INTO this pair. */
    tokenIn: string;
    /** This pair's fee in parts per million (0.3% = 3000). */
    feePpm: number;
    /** Next hop's pair, or the executor contract address on the final hop. */
    recipient: string;
};

export type BuiltArb = {
    hops: Hop[];
    rootAmountIn: bigint;
    /** Predicted, not guaranteed — see the module header. */
    expectedAmountOut: bigint;
    expectedProfit: bigint;
    /** Floor to pass to executeArb; the contract enforces it on-chain. */
    minProfitWei: bigint;
    /** True if candidate.inputAmount had to be reduced by the borrow-size clamp. */
    inputClamped: boolean;
    /** The evaluator's original off-chain input, before clamping. Diagnostics. */
    requestedAmountIn: bigint;
};

const PAIR_IFACE = new Interface([
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

// Clamp on the flash-loan size: never transfer in more than this fraction of
// the FIRST hop's fresh reserveIn (basis points — 1500 = 15%).
//
// This is still needed, but for a narrower reason than before. It is no longer
// guarding the output amounts (the contract computes those from live state); it
// bounds how much we BORROW. An oversized first transfer-in can still overflow
// the pair's uint112 reserve slot on-chain — observed as "OVERFLOW" /
// "TRANSFER_FAILED" reverts on real Polygon candidates — and the evaluator's
// size can still be large on a thin or manipulated pool. Downstream hops need
// no clamp: constant-product math caps each hop's output below that hop's own
// reserveOut.
const MAX_INPUT_FRACTION_BPS = 1500n; // 15%

/**
 * Exact uint112 ceiling for a pair reserve slot.
 *
 * UniswapV2Pair._update reverts with "UniswapV2: OVERFLOW" if either
 * post-swap balance exceeds this. Unlike the evaluator's float64 check in
 * calculus.js, the walk below is BigInt, so this comparison is exact and
 * needs no safety margin.
 *
 * The evaluator already filters these out, so reaching the check here means
 * the index or the DB reserves were stale relative to the chain. Rejecting
 * costs nothing; letting it through costs an eth_estimateGas and a confusing
 * "simulation reverted: OVERFLOW" line in the log.
 */
const UINT112_MAX = (1n << 112n) - 1n;

/**
 * Fee scale, parts per million. MUST stay equal to FlashArbExecutor's
 * FEE_SCALE — the contract and this prediction have to agree bit for bit, so
 * changing one without the other silently desynchronises them.
 */
const FEE_SCALE = 1_000_000n;

/**
 * Convert a decimal fee to parts per million, the form both this module and
 * the contract use. 1e6 covers every fee verify-fees has recovered, including
 * the ones basis points cannot express (0.00195 = 19.5 bps).
 */
export function feeToPpm(fee: number): number {
    if (!Number.isFinite(fee) || fee <= 0) return 0;
    const ppm = Math.round(fee * Number(FEE_SCALE));
    // The contract rejects feePpm >= FEE_SCALE (BadFee), which a 100%-fee
    // config value would trip. Clamp just below so a bad config surfaces as a
    // no-profit candidate rather than a revert.
    return Math.min(ppm, Number(FEE_SCALE) - 1);
}

/** Exact V2 constant-product output. Same form and same scale as the contract's _amountOut. */
function getAmountOutExact(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePpm: number): bigint {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
    const inAfterFee = amountIn * (FEE_SCALE - BigInt(feePpm));
    const denominator = reserveIn * FEE_SCALE + inAfterFee;
    return denominator > 0n ? (inAfterFee * reserveOut) / denominator : 0n;
}

/**
 * Refresh reserves for a candidate's path (one atomic Multicall3 batch) and
 * build the Hop[] for executeArb. Returns null when the path no longer clears
 * minProfitWei at fresh reserves, or when a pair read fails — the caller drops
 * the candidate rather than broadcasting on stale or missing state.
 *
 * @param minProfitWei Minimum acceptable profit in root-token wei. Used both
 *   as the local go/no-go gate and as the contract's on-chain floor, so the
 *   two can never drift apart. Caller derives it the way the evaluator does
 *   (evaluator.ts's thresholdsFor).
 */
export async function buildHops(
    provider: JsonRpcProvider,
    executorAddress: string,
    db: ArbitradeDB,
    candidate: Candidate,
    minProfitWei: bigint,
): Promise<BuiltArb | null> {
    const hops = candidate.hops;
    if (hops.length === 0) throw new Error('candidate has no hops');

    // 1. Atomic multicall for fresh reserves across the whole path.
    const calls: Multicall3Call[] = hops.map(h => ({
        target: h.pair,
        allowFailure: false,
        callData: PAIR_IFACE.encodeFunctionData('getReserves', []),
    }));
    const results = await multicall3(provider, calls);

    const reservesByPair = new Map<string, { reserve0: bigint; reserve1: bigint }>();
    for (let i = 0; i < hops.length; i++) {
        if (!results[i].success) return null; // pair reverted getReserves() — treat as dead
        const decoded = PAIR_IFACE.decodeFunctionResult('getReserves', results[i].returnData);
        reservesByPair.set(hops[i].pair.toLowerCase(), {
            reserve0: decoded[0] as bigint,
            reserve1: decoded[1] as bigint,
        });
    }

    // 2. token0/token1 ordering — fixed at pair creation, cached from the scan.
    // Only used for the local prediction; the contract reads token0() itself,
    // so a stale cache here can mispredict profit but cannot mis-execute.
    const tokenOrder = db.getPairTokenOrder(hops.map(h => h.pair));

    // 3. Walk the path with exact integer math to predict the outcome, and
    // build the Hop[] as we go.
    let amountIn = BigInt(Math.round(candidate.inputAmount));
    const requestedAmountIn = amountIn;
    let rootAmountIn = amountIn;
    let inputClamped = false;
    const builtHops: Hop[] = [];

    for (let i = 0; i < hops.length; i++) {
        const leg = hops[i];
        const pairLower = leg.pair.toLowerCase();
        const reserves = reservesByPair.get(pairLower);
        const order = tokenOrder.get(pairLower);
        if (!reserves || !order) return null; // pair missing from DB — don't guess

        const inIsToken0 = leg.tokenIn.toLowerCase() === order.token0.toLowerCase();
        const reserveIn  = inIsToken0 ? reserves.reserve0 : reserves.reserve1;
        const reserveOut = inIsToken0 ? reserves.reserve1 : reserves.reserve0;

        if (i === 0) {
            // Bound the borrow size — see MAX_INPUT_FRACTION_BPS above.
            const maxSafeInput = (reserveIn * MAX_INPUT_FRACTION_BPS) / 10_000n;
            if (amountIn > maxSafeInput) {
                amountIn = maxSafeInput;
                inputClamped = true;
            }
            rootAmountIn = amountIn;
            if (rootAmountIn <= 0n) return null; // reserveIn itself is ~0 — dead pool
        }

        // Feasibility: the pair must be able to RECEIVE amountIn. The output
        // side always decreases, so only the input side can overflow.
        if (reserveIn + amountIn > UINT112_MAX) return null;

        const feePpm = feeToPpm(leg.fee);
        const amountOut = getAmountOutExact(amountIn, reserveIn, reserveOut, feePpm);
        if (amountOut <= 0n) return null; // drained pool or dust — don't build a doomed tx

        const isLastHop = i === hops.length - 1;

        builtHops.push({
            pair: leg.pair,
            tokenIn: leg.tokenIn,
            feePpm,
            recipient: isLastHop ? executorAddress : hops[i + 1].pair,
        });

        amountIn = amountOut; // chain into next hop's input
    }

    const expectedAmountOut = amountIn;
    const expectedProfit = expectedAmountOut - rootAmountIn;

    if (expectedProfit < minProfitWei) {
        // Edge decayed since evaluation, or was a float-precision phantom that
        // integer math doesn't confirm. Don't spend gas finding out on-chain.
        return null;
    }

    return {
        hops: builtHops,
        rootAmountIn,
        expectedAmountOut,
        expectedProfit,
        minProfitWei,
        inputClamped,
        requestedAmountIn,
    };
}
