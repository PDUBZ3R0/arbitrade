// -----------------------------------------------------------------------------
// Exit pools read straight from the factories, so a liquidator needs no scan.
//
// `yarn scan` walks every pool a chain ever created, and `yarn reserves` then
// reads them all. An exit only ever needs pools between a collateral, a debt
// and the hubs, and a factory answers that directly. Oct 23-24: Polygon's scan
// was still going after 33h, its DB is 7.9 GB, and for a chain that only
// liquidates none of that buys anything this doesn't.
//
//   discovery  factory lookups for each pair, per shape:
//                v2       getPair(a, b)
//                v2fee    getPair(a, b), and (a, b, stable) if hasStableFlag
//                solidly  getPair(a, b, stable), velodrome getPool(a, b, stable)
//                v3       getPool(a, b, fee), tickspacing getPool(a, b, spacing)
//                algebra  poolByPair(a, b)
//              A pair's answer is kept for DISCOVERY_MS.
//              A cold pair took 4-6s on Base (849 factories) and Polygon, which
//              loses a race, so liq-watch keeps assets x hubs warm (warm()).
//   depth      getReserves() / liquidity(), refreshed after DEPTH_MS. Same
//              units as the DB: reserve0 x reserve1, or V3 liquidity. Fresher
//              than `yarn reserves`, so ranking follows where liquidity is now.
//   fee        as `yarn reserves`: conf flat fee, then stableFees, then the
//              factory's fee function. An unknown V2 fee leaves the pool out.
//
// A V3 pool outside the tiers below is invisible here, and only the DB (if the
// chain has one) knows it. Nothing here prices a route: simulation decides.
// -----------------------------------------------------------------------------

import { Interface, ZeroAddress, type JsonRpcProvider } from 'ethers';
import type { NormalizedFactory } from '../util/config.ts';
import { multicall3, type Multicall3Call, type Multicall3Result } from '../util/multicall.ts';
import { feeCallData, makeFeeIface } from '../reserves/fetcher.ts';

export type PoolRow = { address: string; token0: string; token1: string; kind: string; fee: number | null; stable: number | null; factory: string; depth: number };

const FACTORY = new Interface([
    'function getPair(address, address) view returns (address)',
    'function getPair(address, address, bool) view returns (address)',
    'function getPool(address, address, bool) view returns (address)',
    'function getPool(address, address, uint24) view returns (address)',
    'function getPool(address, address, int24) view returns (address)',
    'function poolByPair(address, address) view returns (address)',
]);
const POOL = new Interface([
    'function getReserves() view returns (uint256, uint256, uint256)',
    'function liquidity() view returns (uint128)',
]);

// Fee tiers across Uniswap V3 and Pancake V3 forks, and Slipstream-style spacings.
const FEE_TIERS = [100, 400, 500, 2500, 3000, 10000];
const TICK_SPACINGS = [1, 10, 50, 100, 200, 500, 2000];

const DISCOVERY_MS = 30 * 60_000;
const DEPTH_MS = 30_000;
/** Calls per eth_call. Polygon has hundreds of factories; one aggregate of all of it is too big for public RPCs. */
const BATCH = 500;

type Lookup = { factory: NormalizedFactory; callData: string; kind: 'v2' | 'v3'; fee: number | null; stable: boolean | null };

export const pairKey = (a: string, b: string): string => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    return x < y ? `${x}:${y}` : `${y}:${x}`;
};

export function lookupsFor(f: NormalizedFactory, a: string, b: string): Lookup[] {
    const v2 = (fn: string, args: unknown[], stable: boolean | null): Lookup => ({ factory: f, callData: FACTORY.encodeFunctionData(fn, [a, b, ...args]), kind: 'v2', fee: null, stable });
    const cl = (fn: string, arg: unknown[], fee: number | null): Lookup => ({ factory: f, callData: FACTORY.encodeFunctionData(fn, [a, b, ...arg]), kind: 'v3', fee, stable: null });
    switch (f.group) {
        case 'v2': return [v2('getPair(address,address)', [], null)];
        case 'v2fee': return [
            v2('getPair(address,address)', [], null),
            ...(f.hasStableFlag ? [false, true].map(s => v2('getPair(address,address,bool)', [s], s)) : []),
        ];
        case 'solidly': return [false, true].map(s => v2(f.poolEvent === 'velodrome' ? 'getPool(address,address,bool)' : 'getPair(address,address,bool)', [s], s));
        case 'v3': return f.poolEvent === 'tickspacing'
            ? TICK_SPACINGS.map(s => cl('getPool(address,address,int24)', [s], null))
            : FEE_TIERS.map(t => cl('getPool(address,address,uint24)', [t], t / 1e6));
        case 'algebra': return [cl('poolByPair', [], null)];
    }
}

function addressOf(r: Multicall3Result): string | null {
    // No code at the target answers 0x, and a lookup that is not there reverts.
    if (!r.success || r.returnData.length !== 66) return null;
    const a = `0x${r.returnData.slice(26)}`.toLowerCase();
    return a === ZeroAddress ? null : a;
}

const uintAt = (data: string, word: number): bigint | null => data.length >= 2 + 64 * (word + 1) ? BigInt(`0x${data.slice(2 + 64 * word, 2 + 64 * (word + 1))}`) : null;

export class LivePools {
    private readonly provider: JsonRpcProvider;
    private readonly factories: NormalizedFactory[];
    private readonly discoveryMs: number;
    private readonly depthMs: number;
    private readonly known = new Map<string, { at: number; pools: PoolRow[] }>();
    private readonly depthAt = new Map<string, number>();
    /** Attempts run at once; one at a time here, so the second finds the first's answers. */
    private queue: Promise<void> = Promise.resolve();

    constructor(provider: JsonRpcProvider, factories: NormalizedFactory[], opts: { discoveryMs?: number; depthMs?: number } = {}) {
        this.provider = provider;
        this.factories = factories;
        this.discoveryMs = opts.discoveryMs ?? DISCOVERY_MS;
        this.depthMs = opts.depthMs ?? DEPTH_MS;
    }

    /** Pools between a and b as of the last load. */
    rows(a: string, b: string): PoolRow[] { return this.known.get(pairKey(a, b))?.pools ?? []; }

    /** Every pool loaded so far, per factory, deepest first. */
    byFactory(): Map<string, PoolRow[]> {
        const out = new Map<string, PoolRow[]>();
        for (const { pools } of this.known.values()) for (const p of pools) {
            const list = out.get(p.factory);
            if (list) list.push(p); else out.set(p.factory, [p]);
        }
        for (const list of out.values()) list.sort((x, y) => y.depth - x.depth);
        return out;
    }

    /**
     * Bring these pairs up to date. Never throws: a liquidation with the pools
     * it already knows beats none, so an RPC failure leaves the previous
     * answers (or the DB's) and is asked again next time.
     */
    load(pairs: Array<[string, string]>): Promise<void> {
        const run = this.queue.then(() => this.refresh(pairs)).catch(e => { console.log(`  [!] live pool lookup: ${(e as Error).message.slice(0, 160)}`); });
        this.queue = run;
        return run;
    }

    private async batched(calls: Multicall3Call[]): Promise<Multicall3Result[]> {
        const parts: Array<Promise<Multicall3Result[]>> = [];
        for (let i = 0; i < calls.length; i += BATCH) parts.push(multicall3(this.provider, calls.slice(i, i + BATCH)));
        return (await Promise.all(parts)).flat();
    }

    private async refresh(pairs: Array<[string, string]>): Promise<void> {
        const now = Date.now();
        const wanted = new Map<string, [string, string]>();
        // Lowercase: ethers refuses a mixed-case address with a bad checksum.
        for (const [a, b] of pairs) if (a.toLowerCase() !== b.toLowerCase()) wanted.set(pairKey(a, b), [a.toLowerCase(), b.toLowerCase()]);
        const stale = [...wanted].filter(([k]) => { const e = this.known.get(k); return !e || now - e.at >= this.discoveryMs; });
        if (stale.length) await this.discover(stale, now);
        const old = [...wanted.keys()].flatMap(k => this.known.get(k)?.pools ?? []).filter(p => now - (this.depthAt.get(p.address) ?? 0) >= this.depthMs);
        if (old.length) await this.readDepth(old, now);
        for (const k of wanted.keys()) {
            const e = this.known.get(k);
            if (e) e.pools = e.pools.filter(p => p.depth > 0);   // an empty pool can't take the swap
        }
    }

    private async discover(pairs: Array<[string, [string, string]]>, now: number): Promise<void> {
        const jobs = pairs.flatMap(([key, [a, b]]) => this.factories.flatMap(f => lookupsFor(f, a, b).map(l => ({ key, a, b, l }))));
        const res = await this.batched(jobs.map(j => ({ target: j.l.factory.address, allowFailure: true, callData: j.l.callData })));
        const found = new Map<string, Map<string, PoolRow>>(pairs.map(([k]) => [k, new Map()]));
        const fresh: PoolRow[] = [];
        jobs.forEach((j, i) => {
            const address = addressOf(res[i]);
            const slot = found.get(j.key)!;
            if (!address || slot.has(address)) return;
            const [token0, token1] = j.key.split(':');
            const row: PoolRow = { address, token0, token1, kind: j.l.kind, fee: j.l.fee, stable: j.l.stable == null ? null : j.l.stable ? 1 : 0, factory: j.l.factory.address.toLowerCase(), depth: 0 };
            slot.set(address, row);
            fresh.push(row);
        });
        await this.readMeta(fresh);
        for (const [key, pools] of found) this.known.set(key, { at: now, pools: [...pools.values()] });
        for (const r of fresh) this.depthAt.delete(r.address);
    }

    /** Stable flag and fee of newly found V2-kind pools, as `yarn reserves` sets them. */
    private async readMeta(rows: PoolRow[]): Promise<void> {
        const byAddr = new Map(this.factories.map(f => [f.address.toLowerCase(), f]));
        const v2 = rows.filter(r => r.kind === 'v2');
        const flagged = v2.filter(r => r.stable == null && byAddr.get(r.factory)!.hasStableFlag);
        const flags = await this.batched(flagged.map(r => {
            const fn = byAddr.get(r.factory)!.stableFunction;
            return { target: r.address, allowFailure: true, callData: new Interface([`function ${fn}() view returns (bool)`]).encodeFunctionData(fn, []) };
        }));
        flagged.forEach((r, i) => { if (flags[i].success && flags[i].returnData.length === 66) r.stable = BigInt(flags[i].returnData) === 0n ? 0 : 1; });

        const ask: PoolRow[] = [];
        for (const r of v2) {
            const f = byAddr.get(r.factory)!;
            if (f.fee != null) r.fee = f.fee;
            else if (f.stableFees) r.fee = r.stable === 1 ? f.stableFees.stable : f.stableFees.volatile;
            else if (f.group !== 'v2') ask.push(r);
        }
        const fees = await this.batched(ask.map(r => {
            const f = byAddr.get(r.factory)!;
            return { target: f.feeTarget === 'pair' ? r.address : f.address, allowFailure: true,
                     callData: feeCallData(f, makeFeeIface(f.feeFunction, f.feeTarget, f.feeArgSource), r.address, r.stable === 1) };
        }));
        ask.forEach((r, i) => {
            const raw = fees[i].success ? uintAt(fees[i].returnData, 0) : null;
            const fee = raw == null ? null : Number(raw) / byAddr.get(r.factory)!.feeDivisor;
            if (fee != null && fee < 1) r.fee = fee;
        });
    }

    private async readDepth(rows: PoolRow[], now: number): Promise<void> {
        const res = await this.batched(rows.map(r => ({ target: r.address, allowFailure: true, callData: POOL.encodeFunctionData(r.kind === 'v3' ? 'liquidity' : 'getReserves', []) })));
        rows.forEach((r, i) => {
            const data = res[i].success ? res[i].returnData : '0x';
            const a = uintAt(data, 0), b = r.kind === 'v3' ? 1n : uintAt(data, 1);
            r.depth = a == null || b == null ? 0 : Number(a) * Number(b);
            this.depthAt.set(r.address, now);
        });
    }
}
