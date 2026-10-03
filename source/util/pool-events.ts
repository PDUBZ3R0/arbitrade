// -----------------------------------------------------------------------------
// Pool-creation events: topics and one parser for every shape we scan.
//
// Factory discovery (find-factories), verification (verify-factory,
// verify-v3-factory), scanning (scanner/pairs.ts) and the HyperSync adapter
// all decode the same events. They used to each carry their own copy of the
// V2/Solidly data-offset logic; adding V3 would have meant a fourth and fifth
// copy. This is the one place that knows where the pool address lives.
//
//   V2         PairCreated(address indexed token0, address indexed token1, address pair, uint256)
//              data = [pair, allPairsLength]
//   Solidly    PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint256)
//              data = [stable, pair, allPairsLength]
//   V3         PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
//              Uniswap V3, PancakeV3, and most forks. topic3 = fee, data = [tickSpacing, pool]
//   V3 (ts)    PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)
//              Factories that key pools by tick spacing and set the fee per
//              pool (Velodrome Slipstream / Aerodrome CL style). topic3 = tickSpacing, data = [pool]
//   Algebra    Pool(address indexed token0, address indexed token1, address pool)
//              data = [pool]. Discovered and reported, NOT scanned yet:
//              Algebra pools have a different state layout (globalState,
//              tickTable) and dynamic fees, which calculus-v3 does not model.
//
// For every concentrated-liquidity shape the pool is the LAST data word, so
// the parser does not need to trust anything else about the layout. Fee and
// tick spacing are captured when the event carries them, as a convenience;
// the authoritative values are read from the pool itself at reserves time
// (YoBatches2.getV3State), because a fork can emit one thing and enforce
// another.
// -----------------------------------------------------------------------------

import { ethers } from 'ethers';

export const PAIR_CREATED_V2_TOPIC      = ethers.id('PairCreated(address,address,address,uint256)');
export const PAIR_CREATED_SOLIDLY_TOPIC = ethers.id('PairCreated(address,address,bool,address,uint256)');
export const POOL_CREATED_V3_TOPIC      = ethers.id('PoolCreated(address,address,uint24,int24,address)');
export const POOL_CREATED_V3_TS_TOPIC   = ethers.id('PoolCreated(address,address,int24,address)');
export const POOL_CREATED_ALGEBRA_TOPIC = ethers.id('Pool(address,address,address)');

/** Which event shape a sweep / scan is decoding. */
export type EventLayout = 'v2' | 'solidly' | 'v3' | 'v3ts' | 'algebra';

export const TOPIC_BY_LAYOUT: Record<EventLayout, string> = {
    v2:      PAIR_CREATED_V2_TOPIC,
    solidly: PAIR_CREATED_SOLIDLY_TOPIC,
    v3:      POOL_CREATED_V3_TOPIC,
    v3ts:    POOL_CREATED_V3_TS_TOPIC,
    algebra: POOL_CREATED_ALGEBRA_TOPIC,
};

/** Layouts whose pools are concentrated-liquidity (no getReserves, no Sync). */
export const CL_LAYOUTS: ReadonlySet<EventLayout> = new Set(['v3', 'v3ts', 'algebra']);

/**
 * How a v3-group factory announces pools. Stored in conf as
 * `poolEvent: "uniswap" | "tickspacing"`; maps 1:1 onto a layout.
 */
export type V3PoolEvent = 'uniswap' | 'tickspacing';
export const LAYOUT_BY_POOL_EVENT: Record<V3PoolEvent, EventLayout> = { uniswap: 'v3', tickspacing: 'v3ts' };

export type ParsedCreation = {
    pair: string;
    token0: string;
    token1: string;
    /** Solidly event only; null otherwise. */
    stable: boolean | null;
    /** Fee in pips (3000 = 0.3%) when the event carries it (V3 shape); else null. */
    feePips: number | null;
    /** Tick spacing when the event carries it (both V3 shapes); else null. */
    tickSpacing: number | null;
};

const word = (data: string, i: number) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const addrOf = (w: string) => ('0x' + w.slice(-40)).toLowerCase();
const int24Of = (w: string) => Number(BigInt.asIntN(24, BigInt('0x' + w)));

/**
 * Decode one creation log. Returns null for a log that does not fit the
 * layout (too few topics or data words) instead of producing a garbage
 * address — a sweep across every emitter of a topic will meet some.
 *
 * `topics` must include topic0. Pass `true`/`false` for the legacy
 * solidly/v2 flag used by older callers.
 */
export function parseCreationLog(topics: string[], data: string, layout: EventLayout | boolean): ParsedCreation | null {
    const lay: EventLayout = layout === true ? 'solidly' : layout === false ? 'v2' : layout;
    if (!topics || typeof data !== 'string') return null;
    // Some transports pad absent topic slots with null/''; count real ones only.
    topics = topics.filter(t => typeof t === 'string' && t.length > 2);
    if (topics.length < 3) return null;
    const words = Math.floor((data.length - 2) / 64);
    const token0 = addrOf(topics[1]);
    const token1 = addrOf(topics[2]);
    const base = { token0, token1, stable: null, feePips: null, tickSpacing: null } as Omit<ParsedCreation, 'pair'>;

    switch (lay) {
        case 'v2':
            if (words < 1) return null;
            return { ...base, pair: addrOf(word(data, 0)) };
        case 'solidly':
            if (words < 2) return null;
            return { ...base, pair: addrOf(word(data, 1)), stable: BigInt('0x' + word(data, 0)) === 1n };
        case 'v3': {
            if (words < 1) return null;
            const pair = addrOf(word(data, words - 1));
            // Canonical layout: fee indexed (topic3), data = [tickSpacing, pool].
            const feePips = topics.length >= 4 ? Number(BigInt(topics[3]) & 0xffffffn) : null;
            const tickSpacing = words >= 2 ? int24Of(word(data, words - 2)) : null;
            return { ...base, pair, feePips, tickSpacing };
        }
        case 'v3ts': {
            if (words < 1) return null;
            const pair = addrOf(word(data, words - 1));
            const tickSpacing = topics.length >= 4 ? Number(BigInt.asIntN(24, BigInt(topics[3]))) : null;
            return { ...base, pair, tickSpacing };
        }
        case 'algebra':
            if (words < 1) return null;
            return { ...base, pair: addrOf(word(data, words - 1)) };
    }
}
