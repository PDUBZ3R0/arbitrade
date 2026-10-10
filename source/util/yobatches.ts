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
    'function getReservesPacked(bytes req) view returns (bytes)',
    'function getV3StatePacked(bytes pools, uint256 words) view returns (bytes)',
    'function getReservesByPool(bytes pools) view returns (bytes)',
    // Algebra readers (YoBatches2/3). Same return layouts as the V3 pair above,
    // for globalState/tickTable pools (Algebra V1 and Integral). Present only on
    // a contract redeployed with Algebra support — probed for, like the packed
    // reads, so an older deployment degrades to "no Algebra pools priced".
    'function getAlgebraState(address[] pools, uint256 words) view returns (uint256[])',
    'function getAlgebraStatePacked(bytes pools, uint256 words) view returns (bytes)',
]);

// -----------------------------------------------------------------------------
// Packed transport (YoBatches3). Same reads, a quarter of the calldata and
// about a third of the returndata — see contracts/YoBatches3.sol for the
// layouts. Used automatically when the deployed contract has the packed
// functions; ARB_NO_PACKED=1 forces the ABI forms.
// -----------------------------------------------------------------------------

// getCode is fetched once per address and shared by every selector probe.
const codeCache = new Map<string, Promise<string>>();
function codeOf(provider: JsonRpcProvider, address: string): Promise<string> {
    const key = address.toLowerCase();
    let p = codeCache.get(key);
    if (!p) { p = provider.getCode(address).then(c => c.toLowerCase()).catch(() => '0x'); codeCache.set(key, p); }
    return p;
}

/** Whether `address`'s bytecode contains a `PUSH4 <selector>` for every one of
 *  `fns` — the dispatcher pattern Solidity emits, the same heuristic the packed
 *  probe has always used. Checked against a per-address cached getCode. */
async function hasFns(provider: JsonRpcProvider, address: string, fns: string[]): Promise<boolean> {
    const c = await codeOf(provider, address);
    if (c === '0x') return false;
    return fns.every(fn => c.includes('63' + iface.getFunction(fn)!.selector.slice(2)));
}

/** Whether `address` exposes the packed reads (checked once per address per process). */
export function supportsPacked(provider: JsonRpcProvider, address: string): Promise<boolean> {
    if (process.env.ARB_NO_PACKED === '1') return Promise.resolve(false);
    return hasFns(provider, address, ['getReservesPacked', 'getV3StatePacked', 'getReservesByPool']);
}

/** Cursor over packed bytes. */
class Rd {
    private i = 0;
    private readonly b: Uint8Array;
    constructor(b: Uint8Array) { this.b = b; }
    get done() { return this.i >= this.b.length; }
    u(n: number): bigint {
        if (this.i + n > this.b.length) throw new Error('packed response truncated');
        let v = 0n;
        for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(this.b[this.i++]);
        return v;
    }
    s(n: number): bigint { return BigInt.asIntN(n * 8, this.u(n)); }
    v(): bigint { const l = Number(this.u(1)); if (l > 32) throw new Error('packed VAR length > 32'); return l ? this.u(l) : 0n; }
}
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h.startsWith('0x') ? h.slice(2) : h, 'hex'));

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
    const fix = `Deploy it with \`yarn deploy-contract <chain>\` (or look up Yo3Module#YoBatches3 / Yo2Module#YoBatches2 in ` +
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
    opts: {
        /**
         * Every triple is [pair, pair.token0(), pair.token1()] — true for
         * anything taken from the pairs table. Lets YoBatches3 look the
         * tokens up itself (getReservesByPool, 20 bytes of calldata per
         * pair). Leave unset for arbitrary (holder, tokenA, tokenB) reads.
         */
        canonical?: boolean;
    } = {},
): Promise<ReservesRow[]> {
    if (triples.length === 0) return [];

    if (opts.canonical && await supportsPacked(provider, yobatchesAddress)) {
        const req = '0x' + triples.map(t => t[0].toLowerCase().slice(2)).join('');
        const raw = await provider.call({ to: yobatchesAddress, data: iface.encodeFunctionData('getReservesByPool', [req]) });
        const r = new Rd(hexToBytes(iface.decodeFunctionResult('getReservesByPool', raw)[0] as string));
        const rows = triples.map(([pair, token0, token1]) => ({ pair, token0, reserves0: r.v(), token1, reserves1: r.v() }));
        if (!r.done) throw new Error('getReservesByPool: trailing bytes — layout mismatch');
        return rows;
    }

    if (await supportsPacked(provider, yobatchesAddress)) {
        // Token table: a batch mostly repeats a few root tokens.
        const tokIdx = new Map<string, number>();
        const tokens: string[] = [];
        const idx = (t: string) => {
            const k = t.toLowerCase();
            let i = tokIdx.get(k);
            if (i === undefined) { i = tokens.length; tokIdx.set(k, i); tokens.push(k); }
            return i;
        };
        const entries = triples.map(([pair, a, b]) => [pair.toLowerCase(), idx(a), idx(b)] as const);
        if (tokens.length > 0xffff) throw new Error('getReservesPacked: more than 65535 distinct tokens in one batch');
        const hex = (n: number, bytes: number) => n.toString(16).padStart(bytes * 2, '0');
        const req = '0x' + hex(tokens.length, 2) + tokens.map(t => t.slice(2)).join('') +
            entries.map(([pair, ia, ib]) => pair.slice(2) + hex(ia, 2) + hex(ib, 2)).join('');
        const raw = await provider.call({ to: yobatchesAddress, data: iface.encodeFunctionData('getReservesPacked', [req]) });
        const r = new Rd(hexToBytes(iface.decodeFunctionResult('getReservesPacked', raw)[0] as string));
        const rows = triples.map(([pair, token0, token1]) => ({ pair, token0, reserves0: r.v(), token1, reserves1: r.v() }));
        if (!r.done) throw new Error('getReservesPacked: trailing bytes — layout mismatch');
        return rows;
    }

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
// Window (in tick units) the contract walked around the current tick.
// Deliberately NOT clamped to MIN_TICK/MAX_TICK: v3_swap_exact compares the raw
// word boundary against these before it clamps, so a clamped bound would flag a
// swap reaching the end of the price range as incomplete.
function window(tick: number, tickSpacing: number, words: number): { windowLow: number; windowHigh: number } {
    const w0 = Math.floor(tick / tickSpacing) >> 8;
    return { windowLow: (w0 - words) * 256 * tickSpacing, windowHigh: ((w0 + words) * 256 + 255) * tickSpacing };
}

// Decoders for the two transports. The Algebra reads emit the identical layout,
// so both getV3State* and getAlgebraState* decode through these — `fn` only
// names the function for error messages.
function decodeCLPacked(raw: string, pools: string[], words: number, fn: string): V3StateBatch {
    const r = new Rd(hexToBytes(iface.decodeFunctionResult(fn, raw)[0] as string));
    const block = Number(r.u(8));
    const out: V3StateBatch['pools'] = [];
    for (const address of pools) {
        if (r.u(1) === 0n) { out.push(null); continue; }
        const sqrtPriceX96 = r.v();
        const tick = Number(r.s(3));
        const liquidity = r.v();
        const fee = Number(r.u(3));
        const tickSpacing = Number(r.s(3));
        const n = Number(r.u(2));
        const ticks: V3Pool['ticks'] = [];
        for (let j = 0; j < n; j++) ticks.push({ index: Number(r.s(3)), liquidityNet: r.s(16) });
        out.push({ address, sqrtPriceX96, tick, liquidity, fee, tickSpacing, ticks, ...window(tick, tickSpacing, words) });
    }
    if (!r.done) throw new Error(`${fn}: trailing bytes — layout mismatch`);
    return { block, pools: out };
}

function decodeCLAbi(f: bigint[], pools: string[], words: number, fn: string): V3StateBatch {
    const block = Number(f[0]);
    const out: V3StateBatch['pools'] = [];
    let k = 1;
    for (const address of pools) {
        if (k + 6 > f.length) throw new Error(`${fn}: truncated response at pool ${address}`);
        const sqrtPriceX96 = f[k];
        const tick = Number(i256(f[k + 1]));
        const liquidity = f[k + 2];
        const fee = Number(f[k + 3]);
        const tickSpacing = Number(i256(f[k + 4]));
        const n = Number(f[k + 5]);
        k += 6;
        const ticks: V3Pool['ticks'] = [];
        for (let j = 0; j < n; j++, k += 2) ticks.push({ index: Number(i256(f[k])), liquidityNet: i256(f[k + 1]) });
        if (sqrtPriceX96 === 0n || !(tickSpacing > 0)) { out.push(null); continue; }
        out.push({ address, sqrtPriceX96, tick, liquidity, fee, tickSpacing, ticks, ...window(tick, tickSpacing, words) });
    }
    if (k !== f.length) throw new Error(`${fn}: ${f.length - k} unread words — layout mismatch`);
    return { block, pools: out };
}

async function readCLStates(
    provider: JsonRpcProvider,
    yobatchesAddress: string,
    pools: string[],
    words: number,
    blockTag: number | string | undefined,
    fns: { abi: string; packed: string },
): Promise<V3StateBatch> {
    if (pools.length === 0) return { block: 0, pools: [] };

    if (await supportsPacked(provider, yobatchesAddress) && await hasFns(provider, yobatchesAddress, [fns.packed])) {
        const req = '0x' + pools.map(p => p.toLowerCase().slice(2)).join('');
        const raw = await provider.call({ to: yobatchesAddress, data: iface.encodeFunctionData(fns.packed, [req, words]), blockTag });
        return { ...decodeCLPacked(raw, pools, words, fns.packed), bytes: (raw.length - 2) / 2 };
    }

    const raw = await provider.call({ to: yobatchesAddress, data: iface.encodeFunctionData(fns.abi, [pools, words]), blockTag });
    const f = iface.decodeFunctionResult(fns.abi, raw)[0] as bigint[];
    return { ...decodeCLAbi(f, pools, words, fns.abi), bytes: (raw.length - 2) / 2 };
}

export function getV3States(
    provider: JsonRpcProvider, yobatchesAddress: string, pools: string[], words = 2, blockTag?: number | string,
): Promise<V3StateBatch> {
    return readCLStates(provider, yobatchesAddress, pools, words, blockTag, { abi: 'getV3State', packed: 'getV3StatePacked' });
}

/** Whether `address` can answer Algebra reads at all (ABI or packed form). An
 *  older YoBatches without them should route no Algebra pools here. */
export function supportsAlgebra(provider: JsonRpcProvider, address: string): Promise<boolean> {
    return hasFns(provider, address, ['getAlgebraState']).then(abi => abi || hasFns(provider, address, ['getAlgebraStatePacked']));
}

/**
 * Concentrated-liquidity state for Algebra pools (V1 / Integral), same shape as
 * getV3States. Pools must be Algebra (globalState/tickTable); a Uniswap-V3 pool
 * sent here reads as null (its globalState() call fails). If the deployed
 * YoBatches predates Algebra support, every pool reads null — callers should
 * gate on supportsAlgebra() and leave these pools unpriced rather than crash.
 */
export function getAlgebraStates(
    provider: JsonRpcProvider, yobatchesAddress: string, pools: string[], words = 2, blockTag?: number | string,
): Promise<V3StateBatch> {
    return readCLStates(provider, yobatchesAddress, pools, words, blockTag, { abi: 'getAlgebraState', packed: 'getAlgebraStatePacked' });
}
