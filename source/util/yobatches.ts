// -----------------------------------------------------------------------------
// YoBatches2 client.
//
// YoBatches2 (contracts/YoBatches2.sol) is our on-chain batch reader. It has
// two entry points:
//
//   getReserves  token balances held by each V2-style pair, which we treat as
//                the pair's reserves. Works for V2, Solidly volatile pools and
//                any AMM that holds its tokens in the pair contract.
//
//   getV3State   price, tick, in-range liquidity, fee, tick spacing and the
//                initialized ticks in a window of bitmap words, for
//                concentrated-liquidity pools. Decoded straight into the
//                V3Pool shape calculus-v3.js consumes.
//
// Both degrade per entry rather than per batch: a token with a broken
// balanceOf reads as 0, a pool that does not answer slot0() comes back null.
//
// The original YoBatches (getReservesByPairs, struct return) is retired.
// getReservesByPairs below keeps its name and return shape so the reserves
// fetcher did not have to change, but it calls YoBatches2 — chain.contract in
// conf/<chain>.json5 must point at a YoBatches2 deployment.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface } from 'ethers';
import type { V3Pool } from './calculus-v3.js';

const iface = new Interface([
    'function getReserves(address[3][] args) view returns (uint256[])',
    'function getV3State(address[] pools, uint256 words) view returns (uint256[])',
]);

export type ReservesRow = {
    pair: string;
    token0: string;
    reserves0: bigint;
    token1: string;
    reserves1: bigint;
};

/**
 * Read reserves for a batch of pairs. Order is preserved.
 *
 * `triples` is an array of [pair, token0, token1] tuples. The token ordering
 * doesn't matter to the contract — it just does balanceOf(token, pair) for
 * both — but the reserves in the response follow the order you passed.
 */
/**
 * Fail fast, with a fix, when chain.contract is not a YoBatches2.
 *
 * The usual cause: the retired YoBatches and YoBatches2 were deployed from the
 * same key, and the FIRST deploy on every chain lands at the same address. On
 * a chain where YoBatches went first, that address is the old contract, and
 * every reserves call reverts with "missing revert data" after three retries
 * per batch instead of saying why.
 */
export async function assertYoBatches2(provider: JsonRpcProvider, address: string, chainId?: number): Promise<void> {
    const code = (await provider.getCode(address)).toLowerCase();
    const where = `chain.contract ${address}`;
    const fix = `Deploy it with \`yarn deploy-contract <chain>\` (or look up Yo2Module#YoBatches2 in ` +
        `ignition/deployments/chain-${chainId ?? '<id>'}/deployed_addresses.json) and set chain.contract to that address.`;
    if (code === '0x') throw new Error(`${where} has no code on this chain. ${fix}`);
    const missing = ['getReserves', 'getV3State'].filter(fn => !code.includes('63' + iface.getFunction(fn)!.selector.slice(2)));
    if (missing.length) {
        throw new Error(`${where} is not a YoBatches2 (no ${missing.join('/')} in its bytecode) — probably the ` +
            `retired YoBatches. ${fix}`);
    }
}

export async function getReservesByPairs(
    provider: JsonRpcProvider,
    yobatchesAddress: string,
    triples: Array<[string, string, string]>,
): Promise<ReservesRow[]> {
    if (triples.length === 0) return [];

    const data = iface.encodeFunctionData('getReserves', [triples]);
    const raw = await provider.call({ to: yobatchesAddress, data });
    const flat = iface.decodeFunctionResult('getReserves', raw)[0] as bigint[];
    if (flat.length !== triples.length * 2) {
        throw new Error(`YoBatches2.getReserves returned ${flat.length} words for ${triples.length} pairs ` +
            `— is chain.contract still pointing at the old YoBatches?`);
    }

    return triples.map(([pair, token0, token1], i) => ({
        pair,
        token0,
        reserves0: flat[i * 2],
        token1,
        reserves1: flat[i * 2 + 1],
    }));
}

const i256 = (x: bigint) => BigInt.asIntN(256, x);

export type V3StateBatch = {
    /** block.number the contract read the state at */
    block: number;
    /** Response size in bytes (ABI, before hex) — for throughput diagnostics. */
    bytes?: number;
    /** One entry per requested pool, in order. null = slot0() did not answer
     *  (not a V3-style pool, or an Algebra pool) or tickSpacing unreadable. */
    pools: Array<(V3Pool & { address: string }) | null>;
};

/**
 * Read concentrated-liquidity state for a batch of pools.
 *
 * `words` is the window half-width in tickBitmap words: the contract returns
 * every initialized tick in words [w0 - words, w0 + words] around the current
 * one, and windowLow/windowHigh are set to exactly that range so
 * v3_swap_exact can tell when a swap would need ticks it was not given.
 * One word spans 256 tick spacings — about ±2.6% of price per word at
 * spacing 1, ±91% at spacing 60 — so 1-2 words is plenty for arb sizes on
 * standard tiers; fine-spacing pools may want more.
 *
 * `fee` comes back in pips (3000 = 0.3%), as calculus-v3.js expects.
 */
export async function getV3States(
    provider: JsonRpcProvider,
    yobatchesAddress: string,
    pools: string[],
    words = 2,
    blockTag?: number | string,
): Promise<V3StateBatch> {
    if (pools.length === 0) return { block: 0, pools: [] };

    const data = iface.encodeFunctionData('getV3State', [pools, words]);
    const raw = await provider.call({ to: yobatchesAddress, data, blockTag });
    const f = iface.decodeFunctionResult('getV3State', raw)[0] as bigint[];

    const block = Number(f[0]);
    const out: V3StateBatch['pools'] = [];
    let k = 1;
    for (const address of pools) {
        if (k + 6 > f.length) throw new Error(`getV3State: truncated response at pool ${address}`);
        const sqrtPriceX96 = f[k];
        const tick = Number(i256(f[k + 1]));
        const liquidity = f[k + 2];
        const fee = Number(f[k + 3]);
        const tickSpacing = Number(i256(f[k + 4]));
        const n = Number(f[k + 5]);
        k += 6;
        const ticks: V3Pool['ticks'] = [];
        for (let j = 0; j < n; j++, k += 2) {
            ticks.push({ index: Number(i256(f[k])), liquidityNet: i256(f[k + 1]) });
        }
        if (sqrtPriceX96 === 0n || !(tickSpacing > 0)) { out.push(null); continue; }

        // Same window the contract walked, in tick units. Deliberately NOT
        // clamped to MIN_TICK/MAX_TICK: v3_swap_exact compares the raw word
        // boundary against these before it clamps, so a clamped bound would
        // flag a swap reaching the end of the price range as incomplete.
        const compressed = Math.floor(tick / tickSpacing);
        const w0 = compressed >> 8;
        const windowLow = (w0 - words) * 256 * tickSpacing;
        const windowHigh = ((w0 + words) * 256 + 255) * tickSpacing;

        out.push({ address, sqrtPriceX96, tick, liquidity, fee, tickSpacing, ticks, windowLow, windowHigh });
    }
    if (k !== f.length) throw new Error(`getV3State: ${f.length - k} unread words — layout mismatch`);
    return { block, pools: out, bytes: (raw.length - 2) / 2 };
}
