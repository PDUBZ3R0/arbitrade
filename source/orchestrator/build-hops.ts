// -----------------------------------------------------------------------------
// Hop builder (piece 6).
//
// Turns an evaluator Candidate (piece 5 output — an ordered list of pairs
// forming a triangle, scored with off-chain float math) into a Hop[] ready
// for FlashArbExecutor.executeArb, using FRESH on-chain reserves.
//
// What this does NOT re-derive: fees. Fees are already resolved per-pair by
// the reserves fetcher's metadata step (pairs.fee in the DB — including the
// mutable `degen` flag case for Retro-degen factories) and the evaluator's
// resolveFee() already picked the right one per hop. Candidate.hops[].fee is
// that same cached value, so re-deriving it here would just duplicate logic
// that's already correct and already fresh as of the last `yarn reserves`
// run. Fees are quasi-static; reserves move every block. This module only
// refreshes what actually goes stale between evaluation and execution.
//
// What this DOES re-derive: exact reserves, via one atomic Multicall3 batch
// (single block, so every pair's reserve is mutually consistent), and exact
// swap output via BigInt V2 math — replacing the evaluator's float estimate
// with the same integer arithmetic the contract will actually execute
// against, so a "profitable" build here means profitable on-chain.
//
// What this does NOT do: re-optimize the input amount. It reuses the
// evaluator's `candidate.inputAmount` as the flash-loan size and just
// re-verifies the path clears minProfitWei at fresh reserves. Re-running the
// ternary search against live reserves would find a marginally better input
// size, but isn't required for correctness — a stale-but-still-profitable
// input just leaves a little money on the table, it doesn't produce a bad
// trade. Worth revisiting if profit-per-trade becomes a bottleneck.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';
import type { ArbitradeDB } from '../util/db.ts';
import { multicall3, type Multicall3Call } from '../util/multicall.ts';
import type { Candidate } from '../evaluator/evaluator.ts';

export type Hop = {
    pair: string;
    amount0Out: bigint;
    amount1Out: bigint;
    /** Next hop's pair, or the executor contract address on the final hop. */
    recipient: string;
};

export type BuiltArb = {
    hops: Hop[];
    rootAmountIn: bigint;
    expectedAmountOut: bigint;
    expectedProfit: bigint;
};

const PAIR_IFACE = new Interface([
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

// Integer scale for fee math. Fees are stored off-chain as JS floats
// (e.g. 0.003, 0.0004) with limited real precision already (see
// dex-patterns.ts divisors: 1000 / 10000 / 1e6 / 1e18 — all coarser than
// this in the cases that matter), so 1e9 (ppb) gives comfortable headroom
// without needing to carry the original raw/divisor pair through here.
const FEE_SCALE = 1_000_000_000n;

function feeToScaled(fee: number): bigint {
    return BigInt(Math.round(fee * Number(FEE_SCALE)));
}

/** Exact V2 constant-product swap output, matching the math FlashArbExecutor's pair.swap() will execute on-chain. */
function getAmountOutExact(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, fee: number): bigint {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
    const feeScaled = feeToScaled(fee);
    const amountInWithFee = amountIn * (FEE_SCALE - feeScaled);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * FEE_SCALE + amountInWithFee;
    return denominator > 0n ? numerator / denominator : 0n;
}

/**
 * Refresh reserves for every pair in a candidate's path (one atomic
 * Multicall3 batch — all reads land on the same block) and rebuild the exact
 * Hop[] with BigInt math. Returns null if the path is no longer profitable
 * (or a pair/reserve read failed) — caller should drop the candidate rather
 * than broadcast on stale or missing state.
 *
 * @param minProfitWei Minimum acceptable profit in root-token wei. Caller
 *   derives this the same way the evaluator does (see evaluator.ts's
 *   thresholdsFor): minProfitTokens fraction × 10^decimals for the root
 *   token, from cfg.flashloan.tokens.
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

    // 2. token0/token1 ordering — fixed at pair creation, already cached
    // from the scan, no need to re-fetch on-chain.
    const tokenOrder = db.getPairTokenOrder(hops.map(h => h.pair));

    // 3. Walk the path with exact integer math, building Hop[] as we go.
    let amountIn = BigInt(Math.round(candidate.inputAmount));
    const rootAmountIn = amountIn;
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

        const amountOut = getAmountOutExact(amountIn, reserveIn, reserveOut, leg.fee);
        if (amountOut <= 0n) return null; // drained pool or dust — abandon rather than build a doomed tx

        const isLastHop = i === hops.length - 1;
        const recipient = isLastHop ? executorAddress : hops[i + 1].pair;

        builtHops.push({
            pair: leg.pair,
            amount0Out: inIsToken0 ? 0n : amountOut,
            amount1Out: inIsToken0 ? amountOut : 0n,
            recipient,
        });

        amountIn = amountOut; // chain into next hop's input
    }

    const expectedAmountOut = amountIn;
    const expectedProfit = expectedAmountOut - rootAmountIn;

    if (expectedProfit < minProfitWei) {
        // Edge decayed since evaluation (or was a float-precision phantom
        // that BigInt math doesn't confirm) — don't broadcast.
        return null;
    }

    return { hops: builtHops, rootAmountIn, expectedAmountOut, expectedProfit };
}
