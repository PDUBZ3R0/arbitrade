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
// THREE TRANSPORTS, chosen by what the provider actually permits.
//
// The original design subscribed by topic alone and filtered client-side, on
// the reasoning that no RPC would accept a 100k-address filter. Half right:
// publicnode/allnodes refuses the address-LESS form outright —
//
//   -32701 "Please specify an address in your request or, to remove
//           restrictions, order a dedicated full node"
//
// — so a topic-only eth_getLogs is not a universal baseline, it is a provider
// capability. The watcher therefore probes once at startup and picks:
//
//   subscribe  (wsUrl given)  eth_subscribe('logs', {topics}) pushes matching
//              logs with no polling and no getLogs at all. Best latency, and
//              providers that refuse address-less getLogs generally still
//              allow this because nothing historical is being scanned.
//   topic      address-less eth_getLogs works. The original path.
//   chunked    getLogs works but demands addresses. We hold the full pair set
//              already, so it is split into fixed-size address filters. Costs
//              ceil(pairs/chunkSize) requests per range: fine for Sonic's
//              ~8.6k pairs (18 calls), NOT viable for Polygon's ~100k (200),
//              where a websocket or a dedicated node is the real answer.
//
// Client-side filtering still happens in every mode — most logs in a block are
// not ours, and the discard is one Map lookup.
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

/** keccak256("Sync(uint112,uint112)") — Uniswap V2 and its forks. Verified, not recalled. */
export const SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
/**
 * keccak256("Sync(uint256,uint256)") — Solidly and its forks (Velodrome,
 * Aerodrome, Equalizer, Shadow's legacy pairs, Ramses...). Same two-word data
 * layout as the V2 event, so decodeSync reads both; only the topic differs.
 *
 * Watching only the V2 topic left every Solidly-family pair frozen at its
 * `yarn reserves` snapshot: on Sonic that is Shadow (18k pairs) and Equalizer,
 * and the hot loop kept re-finding the same phantom cycles through them —
 * "edge decayed on fresh reserves" every block, and InsufficientRepay reverts
 * where a stale hop overstated the output.
 */
export const SOLIDLY_SYNC_TOPIC = '0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';
/** Topic-0 filter matching either Sync event (an OR inside position 0). */
export const SYNC_TOPICS: string[] = [SYNC_TOPIC, SOLIDLY_SYNC_TOPIC];

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
    /**
     * Every pair address worth watching. Required for the `chunked` transport
     * and unused otherwise — without it, a provider that demands addresses
     * leaves the watcher with no working strategy.
     */
    addresses?: () => string[];
    /** Addresses per getLogs filter in `chunked` mode. Default 400. */
    addressChunkSize?: number;
    /**
     * In `subscribe` mode, rebuild the websocket if nothing has arrived for
     * this long. Default 45s; 0 disables.
     *
     * A push subscription has no built-in liveness: observed on Sonic via
     * publicnode, the socket simply stopped delivering after ~3 minutes with
     * ZERO errors raised. Nothing reconnects it, so the loop sat there looking
     * healthy and blind. Reconnecting also backfills the gap, which is the
     * part a naive restart would miss.
     */
    staleAfterMs?: number;
    /**
     * `subscribe` mode only: how long to hold pushed logs so that everything
     * one block emits reaches onBatch together. Default 15ms; 0 = one onBatch
     * per log.
     *
     * Per-log delivery let the hot loop attempt on the FIRST Sync of a busy
     * block, priced on that block's intermediate reserves, and then put the
     * remaining logs of the same block on cooldown — observed on Sonic as six
     * handlings of one block, the attempt made on the stale one. A block's
     * logs arrive as a burst within a millisecond or two, so a short window
     * costs almost nothing. While a batch is still being handled, newer logs
     * keep merging (latest per pair) and go out as one batch when it returns,
     * so a slow consumer sees fewer, fresher batches rather than a queue.
     */
    coalesceMs?: number;
};

export type SyncTransport = 'subscribe' | 'topic' | 'chunked';

export type SyncWatcher = {
    stop(): Promise<void>;
    /** Highest block whose Sync logs we hold. 0 in `subscribe` mode until a log arrives. */
    lastBlock(): number;
    /**
     * Highest block the chain has reported, regardless of whether it carried a
     * Sync. This, not lastBlock(), is the liveness signal: a genuinely quiet
     * market advances headBlock while lastBlock stands still, and conflating
     * them makes "no arbitrage right now" indistinguishable from "the socket
     * died".
     */
    headBlock(): number;
    /** Which transport was selected at startup. */
    transport(): SyncTransport;
    /**
     * True once the feed is known to be working — a drained range, an
     * established subscription, or a delivered log. Callers should refuse to
     * trade on a feed that never became ready; `lastBlock() > 0` is NOT a
     * substitute, because a push subscription legitimately reports 0 until the
     * first Sync arrives, which on a quiet chain can be a while.
     */
    ready(): boolean;
    stats(): { batches: number; updatesSeen: number; updatesKept: number; errors: number; blocksDrained: number; logsPushed: number; reconnects: number };
};

/** Does this error mean "the provider wants an address list"? */
function needsAddressFilter(err: unknown): boolean {
    const s = JSON.stringify(err instanceof Error ? (err.message + ((err as any).error?.message ?? '')) : err);
    return /-32701/.test(s) || /specify an address/i.test(s);
}

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

    const stats = { batches: 0, updatesSeen: 0, updatesKept: 0, errors: 0, blocksDrained: 0, logsPushed: 0, reconnects: 0 };
    const staleAfterMs = opts.staleAfterMs ?? 45_000;
    let headBlock = 0;
    let lastActivityAt = Date.now();
    let reconnecting = false;
    let staleTimer: ReturnType<typeof setInterval> | null = null;
    const chunkSize = opts.addressChunkSize ?? 400;
    let transport: SyncTransport = wsUrl ? 'subscribe' : 'topic';
    let ready = false;
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

    type RawLog = { address: string; data: string; blockNumber: number; index: number };

    /**
     * Logs for a block range, by whichever getLogs shape this provider allows.
     *
     * Downgrades once, in place: the first address-less attempt that comes back
     * with -32701 flips the transport to `chunked` for the rest of the process
     * rather than re-learning the restriction on every range. If there is no
     * address list to chunk with, it rethrows — a watcher that silently
     * returned [] here would look like a permanently quiet chain, which is the
     * worst possible failure for this component.
     */
    async function fetchRange(from: number, to: number): Promise<RawLog[]> {
        if (transport !== 'chunked') {
            try {
                return await provider.getLogs({ fromBlock: from, toBlock: to, topics: [SYNC_TOPICS] }) as any;
            } catch (e) {
                if (!needsAddressFilter(e)) throw e;
                const addrs = opts.addresses?.() ?? [];
                if (addrs.length === 0) {
                    throw new Error(
                        'This RPC refuses eth_getLogs without an address filter (-32701) and no address ' +
                        'list was supplied, so ranged backfill is impossible. Pass opts.addresses, use a ' +
                        'websocket (--ws) so logs are pushed instead, or use an RPC without the restriction.',
                        { cause: e as Error },
                    );
                }
                transport = 'chunked';
                opts.onError?.(new Error(
                    `RPC refuses address-less eth_getLogs; switching to chunked address filters ` +
                    `(${addrs.length} addresses / ${chunkSize} per call = ` +
                    `${Math.ceil(addrs.length / chunkSize)} request(s) per range)`,
                ), 'transport downgrade');
            }
        }
        const addrs = opts.addresses?.() ?? [];
        const out: RawLog[] = [];
        for (let i = 0; i < addrs.length && !stopped; i += chunkSize) {
            const slice = addrs.slice(i, i + chunkSize);
            const part = await provider.getLogs({
                fromBlock: from, toBlock: to, address: slice as any, topics: [SYNC_TOPICS],
            }) as any as RawLog[];
            for (const lg of part) out.push(lg);
        }
        // Chunking loses global log order; the collapse below keys on
        // (blockNumber, logIndex) so order of arrival does not matter, but a
        // caller applying raw logs in sequence would be wrong. Sort anyway so
        // this function's contract matches the unchunked path exactly.
        out.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
        return out;
    }

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
                    logs = await fetchRange(from, to);
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
                ready = true;
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

    // Pushed logs waiting to go out as one batch (see opts.coalesceMs).
    const coalesceMs = opts.coalesceMs ?? 15;
    let pending = new Map<string, SyncUpdate>();
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const schedule = () => {
        if (stopped || inFlight || pendingTimer || pending.size === 0) return;
        if (coalesceMs <= 0) { void flush(); return; }
        pendingTimer = setTimeout(() => { pendingTimer = null; void flush(); }, coalesceMs);
    };
    async function flush(): Promise<void> {
        if (stopped || inFlight || pending.size === 0) return;
        const batch = [...pending.values()];
        pending = new Map();
        let toBlock = 0;
        for (const u of batch) if (u.blockNumber > toBlock) toBlock = u.blockNumber;
        inFlight = true;
        stats.updatesKept += batch.length;
        stats.batches++;
        try {
            await opts.onBatch(batch, toBlock);
        } catch (e) {
            fail(e, 'onBatch');
        } finally {
            inFlight = false;
        }
        schedule();
    }

    /** One pushed log: merged into the pending batch, latest per pair wins. */
    const onPushedLog = (lg: any) => {
        if (stopped) return;
        try {
            stats.updatesSeen++;
            stats.logsPushed++;
            ready = true;
            lastActivityAt = Date.now();
            const pair = String(lg.address).toLowerCase();
            if (!opts.isInteresting(pair)) return;
            const d = decodeSync(lg.data);
            if (!d) return;
            const li = lg.index ?? lg.logIndex ?? 0;
            const bn = lg.blockNumber ?? 0;
            if (bn > last) last = bn;
            const prev = pending.get(pair);
            if (prev && (prev.blockNumber > bn || (prev.blockNumber === bn && prev.logIndex >= li))) return;
            pending.set(pair, { pair, reserve0: d.reserve0, reserve1: d.reserve1, blockNumber: bn, logIndex: li });
            schedule();
        } catch (e) {
            fail(e, 'onPushedLog');
        }
    };

    /** Liveness only. A block carries no Sync information by itself. */
    const onHead = (n: number) => {
        if (stopped) return;
        if (n > headBlock) headBlock = n;
        lastActivityAt = Date.now();
    };

    /** Attach both subscriptions to whatever `provider` currently is. */
    async function attachSubscriptions(): Promise<void> {
        await (provider as WebSocketProvider).on({ topics: [SYNC_TOPICS] } as any, onPushedLog);
        provider.on('block', onHead);
    }

    /**
     * Rebuild the websocket and backfill what was missed.
     *
     * The backfill is the whole point. A bare reconnect resumes the push feed
     * but leaves a hole: every Sync emitted while the socket was down is gone,
     * so the in-memory reserves for those pairs stay at pre-gap values and the
     * scorer prices them wrongly until they happen to trade again. So we rewind
     * `last` to just before the gap and drain the range through getLogs —
     * chunked automatically if this provider demands addresses, which is
     * exactly the provider class that makes subscribe mode necessary.
     *
     * Sync is idempotent (absolute reserves, not deltas), so the overlap is
     * free and replaying is always safe.
     */
    async function reconnect(reason: string): Promise<void> {
        if (reconnecting || stopped || !wsUrl) return;
        reconnecting = true;
        const gapFrom = last;
        try {
            stats.reconnects++;
            opts.onError?.(new Error(
                `feed stale (${reason}); rebuilding the websocket` +
                (gapFrom > 0 ? ` and backfilling from block ${gapFrom - overlap}` : ''),
            ), 'reconnect');

            try { ws?.destroy(); } catch { /* already gone */ }
            ws = new WebSocketProvider(wsUrl);
            provider = ws;
            await attachSubscriptions();
            lastActivityAt = Date.now();

            if (gapFrom > 0) {
                // Rewind so drain() walks the gap rather than skipping it.
                last = Math.max(0, gapFrom - overlap);
                primed = true;
                const head = await provider.getBlockNumber();
                if (head > 0) { headBlock = head; await drain(head); }
            }
        } catch (e) {
            fail(e, 'reconnect');
            // Leave `last` where the rewind put it: the next attempt walks the
            // same gap again rather than declaring it covered.
        } finally {
            reconnecting = false;
        }
    }

    if (transport === 'subscribe') {
        // eth_subscribe('logs'). No getLogs, so a provider that refuses the
        // address-less form is irrelevant here.
        //
        // Logs are held for opts.coalesceMs so one block's burst reaches the
        // consumer as one batch — see the option for why per-log delivery
        // was wrong for the hot loop.
        try {
            await attachSubscriptions();
            ready = true;
            try { headBlock = await provider.getBlockNumber(); } catch { /* liveness only */ }
            if (staleAfterMs > 0) {
                staleTimer = setInterval(() => {
                    if (stopped || reconnecting) return;
                    const idle = Date.now() - lastActivityAt;
                    if (idle > staleAfterMs) void reconnect(`${Math.round(idle / 1000)}s without a block or log`);
                }, Math.max(1_000, Math.floor(staleAfterMs / 3)));
                staleTimer.unref?.();
            }
        } catch (e) {
            fail(e, 'log subscription');
            // Fall back to ranged polling over the same websocket.
            transport = 'topic';
        }
    }

    if (transport !== 'subscribe') {
        provider.on('block', onBlock);
        provider.on('block', onHead);
        // Prime: drain once before returning so the caller starts current.
        try {
            const head = await provider.getBlockNumber();
            await drain(head);
        } catch (e) {
            fail(e, 'initial drain');
        }
    }

    return {
        async stop() {
            // `stopped` first: it gates onPushedLog and the drain loops, so
            // anything already in flight becomes a no-op before we touch the
            // transport.
            stopped = true;
            if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
            if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
            try { provider.off('block', onBlock); } catch { /* ignore */ }
            try { provider.off('block', onHead); } catch { /* ignore */ }
            // Deliberately NOT unsubscribing the log filter before destroy().
            // ethers' off() dispatches eth_unsubscribe and resolves before the
            // RPC round trip finishes; destroy() then rejects that still-queued
            // payload with "provider destroyed; cancelled request", and nobody
            // owns that rejection, so it surfaces as an unhandled rejection and
            // takes the process down. Closing the socket ends the subscription
            // anyway, which is all stop() actually needs.
            // Observed as a crash in `await watcher.stop()` — i.e. on Ctrl+C.
            if (ws) { try { await ws.destroy(); } catch { /* ignore */ } }
            else { try { (provider as JsonRpcProvider).destroy(); } catch { /* ignore */ } }
        },
        lastBlock: () => last,
        headBlock: () => headBlock,
        transport: () => transport,
        ready: () => ready,
        stats: () => ({ ...stats }),
    };
}
