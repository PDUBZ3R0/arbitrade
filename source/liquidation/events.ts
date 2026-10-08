// -----------------------------------------------------------------------------
// Feeding Aave V3 Pool events into the watchlist.
//
//   backfill   HyperSync, pool address + WATCH_TOPICS, from the start block to
//              the head. One filtered stream; a Pool's whole history is a few
//              requests. Falls back to chunked eth_getLogs when the chain has
//              no hypersyncUrl or no ENVIO_API_TOKEN.
//   tail       chunked eth_getLogs on the chain's own RPC from lastBlock+1.
//              Used every tick by --follow and to close the gap between a
//              HyperSync archive height and the RPC head.
//
// Both transports normalise to RawLog and go through the same decode +
// LiqDB.applyEvents, so the backfill path and the tail path cannot disagree
// about what an event means.
//
// REORGS are not handled, deliberately: an event can only ADD an account or
// mark one for re-checking. A reorged-out Borrow leaves a harmless extra
// account whose health read says it has no debt. Nothing here decides a trade
// on event contents — every decision is a fresh on-chain health read.
// -----------------------------------------------------------------------------

import type { JsonRpcProvider } from 'ethers';
import { WATCH_TOPICS, decodePoolEvent, type RawLog } from './aave-v3.ts';
import type { VenueEvent } from './venue.ts';

/**
 * What to listen to: contracts, topic0s, and how a log names an account.
 * Every Venue satisfies this; omitted, it is the Aave Pool in `db.pool`.
 */
export type EventSource = {
    eventAddresses: string[];
    eventTopics: string[];
    decodeEvent(log: RawLog): VenueEvent | null;
};
const aaveSource = (db: LiqDB): EventSource => ({ eventAddresses: [db.pool], eventTopics: WATCH_TOPICS, decodeEvent: decodePoolEvent });
// Providers cap the address list of one filter; 200 is well inside the usual limits.
const ADDR_CHUNK = 200;
import type { LiqDB } from './watchlist-db.ts';

// Same families the pair scanner adapts on (scanner/pairs.ts).
const CHUNK_TOO_LARGE_RE = /(response size|range|limit|too large|too many|free tier|upgrade|10 block)/i;
const TRANSIENT_ERROR_RE = /(rate limit|timeout|429|502|503|504|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network|gateway)/i;
// Outright refusals: the provider will reject this filter shape every time
// (policy block, unsupported method, malformed request). Retrying can never
// succeed, so surface it immediately — the caller skips this venue's tick.
const BLOCKED_RE = /request blocked|-3260[12]|method not found|not supported|unsupported|not available|not allowed/i;
// Backstop: even a genuinely-transient-looking error that never clears must
// not loop forever inside one venue's tail — a sequential tracks loop would
// then never reach the other venues. Give up after this many in a row.
const MAX_TRANSIENT_FAILS = 6;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function suggestedRange(msg: string): number | null {
    const m = msg.match(/\[(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\]/i);
    if (!m) return null;
    const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
    return Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo ? hi - lo + 1 : null;
}

export type FeedResult = { logs: number; touched: Set<string>; throughBlock: number; calls: number };

function apply(db: LiqDB, src: EventSource, logs: RawLog[], through: number, touched: Set<string>): void {
    const events = [];
    for (const l of logs) {
        const e = src.decodeEvent(l);
        if (e) events.push(e);
    }
    for (const u of db.applyEvents(events, through)) touched.add(u);
}

/**
 * Chunked eth_getLogs for the pool over [from, to], applied to `db` chunk by
 * chunk (progress is durable after every chunk). Adapts the chunk the same way
 * the pair scanner does.
 */
export async function tailRpc(
    provider: JsonRpcProvider,
    db: LiqDB,
    from: number,
    to: number,
    opts: { chunk?: number; chunkMin?: number; chunkMax?: number; log?: (s: string) => void; source?: EventSource } = {},
): Promise<FeedResult> {
    const log = opts.log ?? (() => {});
    const src = opts.source ?? aaveSource(db);
    const chunkMin = opts.chunkMin ?? 10, chunkMax = opts.chunkMax ?? 50_000;
    let chunk = opts.chunk ?? 5_000;
    const touched = new Set<string>();
    let cursor = from, total = 0, calls = 0, transientFails = 0;
    while (cursor <= to) {
        const end = Math.min(cursor + chunk - 1, to);
        let logs: RawLog[];
        try {
            logs = [];
            for (let i = 0; i < src.eventAddresses.length; i += ADDR_CHUNK) {
                const part = await provider.getLogs({
                    address: src.eventAddresses.slice(i, i + ADDR_CHUNK), topics: [src.eventTopics], fromBlock: cursor, toBlock: end,
                }) as unknown as RawLog[];
                calls++;
                logs = logs.concat(part);
            }
            transientFails = 0;
        } catch (err) {
            const raw = err as any;
            const msg = `${raw?.message ?? String(err)} ${raw?.error?.message ?? raw?.info?.error?.message ?? ''}`;
            const s = suggestedRange(msg);
            if (s && chunk > s) { chunk = s; continue; }
            if (CHUNK_TOO_LARGE_RE.test(msg) && chunk > chunkMin) { chunk = Math.max(chunkMin, Math.floor(chunk / 2)); continue; }
            // Refused outright → never retryable. Throw so the caller skips this
            // venue this tick instead of spinning on it forever.
            if (BLOCKED_RE.test(msg)) throw new Error(`getLogs ${cursor}-${end} on ${db.pool} refused (unsupported filter?): ${msg.slice(0, 180)}`);
            if (TRANSIENT_ERROR_RE.test(msg) && ++transientFails <= MAX_TRANSIENT_FAILS) {
                log(`  [!] transient getLogs error (${transientFails}/${MAX_TRANSIENT_FAILS}), backing off 5s: ${msg.slice(0, 80)}`);
                await sleep(5000); continue;
            }
            throw new Error(`getLogs ${cursor}-${end} on ${db.pool}: ${msg.slice(0, 200)}`);
        }
        // Several address chunks can interleave; the watchlist cares about order within an account.
        if (src.eventAddresses.length > ADDR_CHUNK) logs.sort((a, b) => a.blockNumber - b.blockNumber);
        apply(db, src, logs, end, touched);
        total += logs.length;
        cursor = end + 1;
        if (chunk < chunkMax && logs.length < 1000) chunk = Math.min(chunkMax, Math.floor(chunk * 1.25));
    }
    return { logs: total, touched, throughBlock: to, calls };
}

/**
 * HyperSync log -> RawLog. The NAPI client returns `topics` with null for
 * absent slots and camelCase fields; tolerate the snake_case spellings too.
 */
export function fromHyperSyncLog(l: any): RawLog {
    return {
        address: (l.address ?? l.Address ?? '').toLowerCase() || undefined,
        topics: (l.topics ?? []).filter((t: unknown) => t != null),
        data: l.data ?? l.Data ?? '0x',
        blockNumber: Number(l.blockNumber ?? l.block_number),
    };
}

/**
 * HyperSync backfill over [from, to]. Returns the block it actually reached,
 * which is min(to, archive height) — HyperSync can trail the RPC head by a few
 * blocks, so the caller tails the remainder over RPC.
 */
export async function backfillHyperSync(
    hypersyncUrl: string,
    apiToken: string,
    db: LiqDB,
    from: number,
    to: number,
    log: (s: string) => void = () => {},
    source?: EventSource,
): Promise<FeedResult> {
    const src = source ?? aaveSource(db);
    const mod: any = await import('@envio-dev/hypersync-client');
    const HypersyncClient = mod.HypersyncClient;
    if (!HypersyncClient) throw new Error('HypersyncClient not exported by @envio-dev/hypersync-client');
    // Static factory first: `new` throws "Class contains no constructor" on the
    // installed NAPI bindings (see util/hypersync.ts).
    const clientConfig = { url: hypersyncUrl, apiToken, bearerToken: apiToken };
    const client: any = typeof HypersyncClient.new === 'function' ? HypersyncClient.new(clientConfig) : new HypersyncClient(clientConfig);

    let query: any = {
        fromBlock: from,
        toBlock: to + 1,   // exclusive
        logs: [{ address: src.eventAddresses.map(a => a.toLowerCase()), topics: [src.eventTopics] }],
        fieldSelection: { log: ['Address', 'BlockNumber', 'Data', 'Topic0', 'Topic1', 'Topic2', 'Topic3'] },
        joinMode: mod.JoinMode?.JoinNothing ?? 2,
    };
    const touched = new Set<string>();
    let total = 0, calls = 0, through = from - 1;
    while (true) {
        let res: any;
        try { res = await client.get(query); }
        catch (err) {
            const msg = (err as Error).message ?? String(err);
            if (/token|auth|401|403/i.test(msg)) throw new Error(`HyperSync auth failed. Check ENVIO_API_TOKEN. (${msg})`);
            throw new Error(`HyperSync query failed at block ${query.fromBlock}: ${msg}`);
        }
        calls++;
        const logs: RawLog[] = (res?.data?.logs ?? []).map(fromHyperSyncLog);
        const nextBlock: number | undefined = res?.nextBlock;
        through = nextBlock != null ? Math.min(to, nextBlock - 1) : to;
        apply(db, src, logs, through, touched);
        total += logs.length;
        log(`\r  [hypersync] block ${through}/${to} — ${total} events, ${db.count()} borrowers`);
        if (nextBlock == null || nextBlock >= query.toBlock) break;
        if (nextBlock <= query.fromBlock) { log(`\n  [hypersync] nextBlock did not advance at ${nextBlock} — stopping`); break; }
        query = { ...query, fromBlock: nextBlock };
    }
    log('\n');
    return { logs: total, touched, throughBlock: through, calls };
}
