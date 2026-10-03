// -----------------------------------------------------------------------------
// Live reserve feed: Sync(uint112,uint112) across every V2-style pair.
//
// Every V2 pair emits Sync at the end of swap(), mint() and burn() carrying its
// post-trade reserves. That makes Sync the authoritative, push-based answer to
// "what are this pair's reserves right now", and it is why the live loop does
// not need to poll `getReserves` or re-run `yarn reserves`.
//
// DESIGN NOTES, mostly about things that bite:
//
// No address filter. We care about ~100k pairs on Polygon; no RPC will accept
// an address list that size, and splitting it into thousands of filters is
// worse than not filtering. So we subscribe by topic alone and discard
// uninteresting pairs client-side. Most events in a block are not ours — that
// is expected, and the discard is a single Map lookup.
//
// Block ranges, not single blocks. On an HTTP provider ethers polls for new
// blocks every `pollingInterval`, so on a sub-second chain like Sonic several
// blocks land between polls. Fetching logs for "the block we were told about"
// silently drops the ones in between, which shows up as reserves that are
// subtly wrong rather than as an error. We therefore track the last block we
// actually processed and always fetch the whole range since then.
//
// Collapse per pair. One block can hold many swaps on the same pair. Only the
// last Sync in log order is current, so updates are collapsed by pair keeping
// the highest (blockNumber, logIndex) — applying them in arrival order would
// also work, but collapsing means the scorer re-scores each affected triangle
// once per block instead of once per swap.
//
// Overlap on restart. After a reconnect we re-fetch a few blocks we have
// already seen. Sync is idempotent — it carries absolute reserves, not deltas —
// so replaying it is harmless, and it is much cheaper than missing a block.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, WebSocketProvider, type Provider } from 'ethers';

/** keccak256("Sync(uint112,uint112)") — verified, not recalled. */
export const SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';

export type SyncUpdate = {
    pair: string;          // lowercase
    reserve0: number;      // float, matching the index's storage
    reserve1: number;
    blockNumber: number;
    logIndex: number;
};

export type SyncWatcherOptions = {
    /**
     * Called once per drained range with the collapsed updates for pairs the
     * caller cares about. Never called with an empty array.
     */
    onBatch: (updates: SyncUpdate[], toBlock: number) => void | Promise<void>;
    /** Return false to discard a pair's updates before they reach onBatch. */
    isInteresting: (pair: string) => boolean;
    /** Called on recoverable trouble; the watcher keeps running. */
    onError?: (err: Error, context: string) => void;
    /** Max blocks per getLogs call. Default 500 — most RPCs accept far more, but a backlog shouldn't produce one enormous request. */
    maxBlockSpan?: number;
    /** Blocks to re-fetch on start/reconnect. Default 2. */
    overlapBlocks?: number;
    /** HTTP polling interval, ms. Ignored on a websocket. Default 1000. */
    pollMs?: number;
};

export type SyncWatcher = {
    stop(): Promise<void>;
    /** Last block whose logs have been drained. */
    lastBlock(): number;
    stats(): { batches: number; updatesSeen: number; updatesKept: number; errors: number; blocksDrained: number };
};

/** Decode a Sync log's data field: two uint112 packed into two 32-byte words. */
export function decodeSync(data: string): { reserve0: number; reserve1: number } | null {
    // 0x + 2 * 64 hex chars
    if (typeof data !== 'string' || data.length < 2 + 128) return null;
    const body = data.startsWith('0x') ? data.slice(2) : data;
    // Number() on a hex BigInt: reserves are uint112 (max ~5.2e33) which
    // exceeds Number.MAX_SAFE_INTEGER, so precision is lost in the low digits.
    // That is the same precision the batch evaluator works at (it stores
    // reserves as Number too), so the two agree — and float64 carries ~15-16
    // significant digits, far more than the ~5 that matter for sizing.
    const r0 = BigInt('0x' + body.slice(0, 64));
    const r1 = BigInt('0x' + body.slice(64, 128));
    return { reserve0: Number(r0), reserve1: Number(r1) };
}

/**
 * Start watching. Uses a websocket when `wsUrl` is given (real push), otherwise
 * polls the HTTP provider for new blocks.
 *
 * Resolves once the first drain has completed, so callers can be sure the index
 * is current before they start trading on it.
 */
export async function watchSync(
    httpUrl: string,
    wsUrl: string | undefined,
    opts: SyncWatcherOptions,
): Promise<SyncWatcher> {
    const maxSpan = opts.maxBlockSpan ?? 500;
    const overlap = opts.overlapBlocks ?? 2;
    const pollMs = opts.pollMs ?? 1000;

    let provider: Provider;
    let ws: WebSocketProvider | null = null;
    if (wsUrl) {
        ws = new WebSocketProvider(wsUrl);
        provider = ws;
    } else {
        const http = new JsonRpcProvider(httpUrl, undefined, { staticNetwork: true });
        http.pollingInterval = pollMs;
        provider = http;
    }

    const stats = { batches: 0, updatesSeen: 0, updatesKept: 0, errors: 0, blocksDrained: 0 };
    let last = 0;
    let stopped = false;
    let draining = false;
    /** Highest block anyone has asked us to drain to. Monotonic. */
    let target = 0;
    /**
     * Whether a range has ever been drained. Distinct from `last === 0`: on a
     * fresh chain the head genuinely IS block 0, and using `last === 0` as the
     * "never drained" sentinel makes the catch-up condition permanently true
     * there, spinning forever.
     */
    let primed = false;

    const fail = (e: unknown, ctx: string) => {
        stats.errors++;
        opts.onError?.(e instanceof Error ? e : new Error(String(e)), ctx);
    };

    async function drain(toBlock: number): Promise<void> {
        // Coalesce, do not drop. Only one drain runs at a time — a slow getLogs
        // must not let the next block tick start an overlapping walk, which
        // would write reserves out of order. But an early version simply
        // returned when a drain was in flight, which silently discarded that
        // block notification: nothing re-triggered the catch-up, so the feed
        // sat permanently one block behind and only advanced when the NEXT
        // block happened to arrive while idle. On a quiet chain it could stay
        // behind indefinitely. Recording the highest requested target and
        // looping until caught up fixes that without reintroducing concurrency.
        target = Math.max(target, toBlock);
        if (draining || stopped) return;
        draining = true;
        try {
          while (!stopped && (!primed || last < target)) {
            let from = primed ? last + 1 : Math.max(0, target - overlap);
            const until = target;
            while (from <= until && !stopped) {
                const to = Math.min(from + maxSpan - 1, until);
                let logs: Array<{ address: string; data: string; blockNumber: number; index: number }>;
                try {
                    logs = await provider.getLogs({ fromBlock: from, toBlock: to, topics: [SYNC_TOPIC] }) as any;
                } catch (e) {
                    fail(e, `getLogs ${from}-${to}`);
                    // Leave `last` alone so the next tick retries this range
                    // rather than skipping past it. Abandoning the whole drain
                    // (rather than breaking the inner loop) is deliberate: the
                    // outer loop's condition is `last < target`, and `last` has
                    // not advanced, so breaking inward would spin forever
                    // hammering a failing RPC. `target` is retained, so the
                    // next block tick picks the range up again.
                    return;
                }

                // Collapse by pair, keeping the latest log.
                const latest = new Map<string, SyncUpdate>();
                for (const lg of logs) {
                    stats.updatesSeen++;
                    const pair = String(lg.address).toLowerCase();
                    if (!opts.isInteresting(pair)) continue;
                    const d = decodeSync(lg.data);
                    if (!d) continue;
                    const prev = latest.get(pair);
                    const li = (lg as any).index ?? (lg as any).logIndex ?? 0;
                    if (prev && (prev.blockNumber > lg.blockNumber ||
                        (prev.blockNumber === lg.blockNumber && prev.logIndex >= li))) continue;
                    latest.set(pair, {
                        pair, reserve0: d.reserve0, reserve1: d.reserve1,
                        blockNumber: lg.blockNumber, logIndex: li,
                    });
                }

                stats.blocksDrained += to - from + 1;
                last = to;
                primed = true;
                if (latest.size > 0) {
                    stats.updatesKept += latest.size;
                    stats.batches++;
                    try {
                        await opts.onBatch([...latest.values()], to);
                    } catch (e) {
                        // A throwing consumer must not kill the feed.
                        fail(e, 'onBatch');
                    }
                }
                from = to + 1;
            }
          }
        } finally {
            draining = false;
        }
    }

    const onBlock = (n: number) => { void drain(n).catch(e => fail(e, 'drain')); };
    provider.on('block', onBlock);

    // Prime: drain once before returning so the caller starts current.
    try {
        const head = await provider.getBlockNumber();
        await drain(head);
    } catch (e) {
        fail(e, 'initial drain');
    }

    return {
        async stop() {
            stopped = true;
            try { provider.off('block', onBlock); } catch { /* ignore */ }
            if (ws) { try { await ws.destroy(); } catch { /* ignore */ } }
            else { try { (provider as JsonRpcProvider).destroy(); } catch { /* ignore */ } }
        },
        lastBlock: () => last,
        stats: () => ({ ...stats }),
    };
}
