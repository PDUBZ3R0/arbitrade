// -----------------------------------------------------------------------------
// The fee an Algebra V1 pool's NEXT swap will charge.
//
// Algebra V1 has a dynamic fee. globalState().fee is what the LAST swap paid;
// the first swap in a new block writes a timepoint and recomputes the fee
// from the pool's volatility oracle (dataStorageOperator().getFee) before it
// prices anything. Pricing at globalState().fee is right only while
// volatility hasn't moved since that last swap.
//
// Polygon, 2026-11-01: QuickSwap V3 pool 0x1a8a985d (LUNA/WPOL) had 2780 in
// globalState and charged ~10,800 on the next swap. Path #2844927 came up
// 0.69–0.77% short of its prediction at its own quote block three times;
// the on-chain quoter matched the executor to 3 ppm, and our math on the
// pool's state matched every other hop to the wei.
//
// The operator only answers its own pool (require(msg.sender == pool)), so the
// call is an eth_call "from" the pool. Algebra 1.9 (directional fees,
// getFees) and Integral (plugin()) have no getFee: the read fails and the
// stored fee stands.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';

const POOL = new Interface([
    'function dataStorageOperator() view returns (address)',
    'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)',
]);
const OPERATOR = new Interface(['function getFee(uint32 time, int24 tick, uint16 index, uint128 liquidity) view returns (uint16)']);

/** Pool → its operator, or null when it has none (not Algebra V1). Never changes for a pool. */
const operatorOf = new Map<string, string | null>();

/**
 * The fee (pips, 1e-6) the pool's next swap at `time` will charge, given the
 * state read at `blockTag`, or null if the pool can't say (not Algebra V1,
 * or a read failed). Callers keep the higher of this and the stored fee.
 */
export async function algebraV1NextFee(
    provider: JsonRpcProvider, pool: string, state: { tick: number; liquidity: bigint }, time: number, blockTag?: number,
): Promise<number | null> {
    const key = pool.toLowerCase();
    try {
        let operator = operatorOf.get(key);
        if (operator === undefined) {
            try {
                const raw = await provider.call({ to: pool, data: POOL.encodeFunctionData('dataStorageOperator', []) });
                operator = raw.length >= 66 ? (POOL.decodeFunctionResult('dataStorageOperator', raw)[0] as string) : null;
            } catch { operator = null; }
            operatorOf.set(key, operator);
        }
        if (!operator) return null;
        const gs = POOL.decodeFunctionResult('globalState', await provider.call({ to: pool, data: POOL.encodeFunctionData('globalState', []), blockTag }));
        const raw = await provider.call({
            from: pool, to: operator, blockTag,
            data: OPERATOR.encodeFunctionData('getFee', [time, state.tick, gs.timepointIndex, state.liquidity]),
        });
        const fee = Number(OPERATOR.decodeFunctionResult('getFee', raw)[0]);
        return Number.isFinite(fee) && fee > 0 ? fee : null;
    } catch {
        return null;
    }
}

/** For tests: forget cached operators. */
export function resetAlgebraOperatorCache(): void { operatorOf.clear(); }
