// -----------------------------------------------------------------------------
// Empirical fee verification via historical Swap events.
//
// Complements decompile-fee.ts (bytecode-based). Where sevm decompilation
// can fail to reach the fee-check section of a contract (observed on Sonic:
// SpookySwap's decompiled body cuts off before the K-invariant check), this
// method sidesteps bytecode entirely: it reads REAL swaps the pool already
// executed and solves the constant-product formula for the one unknown.
//
// A V2-style pair's swap() calls _update() — which emits Sync(post-reserves)
// — and then emits Swap(amounts). Pairing each Swap with the nearest
// PRECEDING Sync from the same pair in the same transaction gives:
//   preReserve0 = postReserve0 - amount0In + amount0Out
//   preReserve1 = postReserve1 - amount1In + amount1Out
//   fee = 1 - (amountOut * reserveIn) / (amountIn * (reserveOut - amountOut))
//
// LOG DISCOVERY — two transports:
//   1. HyperSync (preferred when configured): queries Swap+Sync logs for the
//      pair across FULL history, walking backward in windows until enough
//      swaps are found. No RPC range limits apply.
//   2. RPC fallback: walks backward in chunks, learning the RPC's getLogs
//      range cap by binary search (see fetchLogsRpc), within a fixed block
//      budget. Reports exactly what range it searched and any error it hit.
//
// History: the first version of this module searched 10k/100k/1M-block
// windows in single getLogs calls and silently swallowed errors. On Sonic
// (sub-second blocks) 10k blocks is only a few hours, and the larger windows
// exceed virtually every public RPC's range cap — so pairs that hadn't
// traded in the last few hours were reported as "no swaps in 1M blocks"
// when nothing past 10k was ever actually searched. Never swallow the error.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';

const SWAP_SYNC_IFACE = new Interface([
    'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
    'event Sync(uint112 reserve0, uint112 reserve1)',
]);
export const SWAP_TOPIC = SWAP_SYNC_IFACE.getEvent('Swap')!.topicHash;
export const SYNC_TOPIC = SWAP_SYNC_IFACE.getEvent('Sync')!.topicHash;

/** How many recent swaps to try to recover a fee from. */
const TARGET_SWAPS = 10;
/** Samples within this distance of the median count as "agreeing". */
const AGREE_TOLERANCE = 0.0002;
/** Snap to the nearest half basis point when within this distance of it. */
const SNAP_GRID = 0.00005;
const SNAP_TOLERANCE = 0.00002;

export type HyperSyncConfig = { url: string; apiToken: string };

/** Minimal log shape both transports normalize into. */
export type RawLog = {
    txHash: string;
    logIndex: number;
    blockNumber: number;
    topics: string[];
    data: string;
};

export type EmpiricalFeeSample = {
    txHash: string;
    blockNumber: number;
    fee: number;
};

export type EmpiricalFeeResult = {
    fee: number | null;
    /**
     * 'derived'   — 2+ swaps agree with the median, and they're a majority.
     * 'ambiguous' — only 1 usable sample, or no majority agreement (possible
     *               dynamic fee, or a fee-on-transfer token skewing amounts).
     * 'unknown'   — no usable Swap+Sync pair found.
     */
    confidence: 'derived' | 'ambiguous' | 'unknown';
    samples: EmpiricalFeeSample[];
    /** Which transport found the logs, and what range it actually covered. */
    transport: 'hypersync' | 'rpc';
    searchedFromBlock: number;
    searchedToBlock: number;
    /** Total Swap events found in the searched range (before fee recovery). */
    swapsFound: number;
    error?: string;
};

// -----------------------------------------------------------------------------
// Pure helpers (exported for testing)

/**
 * Pair each Swap log with the nearest preceding Sync log from the same pair
 * within the same transaction. Logs must all be from ONE pair address.
 * A Sync is consumed once it's paired, so two swaps on the same pair in one
 * tx each get their own Sync. A Swap with no preceding Sync is dropped
 * rather than guessed.
 */
export function pairSwapsWithSyncs(logs: RawLog[]): Array<{ swap: RawLog; sync: RawLog }> {
    const byTx = new Map<string, RawLog[]>();
    for (const l of logs) {
        const arr = byTx.get(l.txHash) ?? [];
        arr.push(l);
        byTx.set(l.txHash, arr);
    }
    const pairs: Array<{ swap: RawLog; sync: RawLog }> = [];
    for (const txLogs of byTx.values()) {
        txLogs.sort((a, b) => a.logIndex - b.logIndex);
        let pendingSync: RawLog | null = null;
        for (const l of txLogs) {
            const t0 = l.topics[0]?.toLowerCase();
            if (t0 === SYNC_TOPIC) {
                pendingSync = l;
            } else if (t0 === SWAP_TOPIC) {
                if (pendingSync) pairs.push({ swap: l, sync: pendingSync });
                pendingSync = null;
            }
        }
    }
    return pairs;
}

/** Recover the fee from one Swap + its Sync. Returns null if unusable. */
export function recoverFee(swap: RawLog, sync: RawLog): number | null {
    let s, y;
    try {
        s = SWAP_SYNC_IFACE.decodeEventLog('Swap', swap.data, swap.topics);
        y = SWAP_SYNC_IFACE.decodeEventLog('Sync', sync.data, sync.topics);
    } catch {
        return null; // non-standard event shape — don't guess
    }
    const a0In: bigint = s.amount0In, a1In: bigint = s.amount1In;
    const a0Out: bigint = s.amount0Out, a1Out: bigint = s.amount1Out;
    const pre0 = (y.reserve0 as bigint) - a0In + a0Out;
    const pre1 = (y.reserve1 as bigint) - a1In + a1Out;

    let aIn: bigint, aOut: bigint, rIn: bigint, rOut: bigint;
    if (a0In > 0n && a1In === 0n)      { aIn = a0In; aOut = a1Out; rIn = pre0; rOut = pre1; }
    else if (a1In > 0n && a0In === 0n) { aIn = a1In; aOut = a0Out; rIn = pre1; rOut = pre0; }
    else return null; // both-sides-in or zero-in (flash swap/repay shapes) — skip

    if (aIn <= 0n || aOut <= 0n || rIn <= 0n || rOut <= aOut) return null;

    // Number() only for the final ratio: BigInt division would truncate the
    // fee itself. Doubles carry ~15-17 significant digits — far more than
    // ppm-level fee precision needs.
    const num = Number(aOut * rIn);
    const den = Number(aIn * (rOut - aOut));
    if (!(den > 0)) return null;
    const fee = 1 - num / den;
    return (fee >= -0.001 && fee < 0.2) ? fee : null;
}

/** Snap to the nearest half basis point if within rounding noise of it. */
export function snapFee(fee: number): number {
    const snapped = Math.round(fee / SNAP_GRID) * SNAP_GRID;
    if (Math.abs(snapped - fee) <= SNAP_TOLERANCE) return Math.round(snapped * 1e6) / 1e6;
    return Math.round(fee * 1e6) / 1e6;
}

/** Median + majority-agreement verdict over recovered fee samples. */
export function summarize(samples: EmpiricalFeeSample[]): Pick<EmpiricalFeeResult, 'fee' | 'confidence'> & { error?: string } {
    if (samples.length === 0) return { fee: null, confidence: 'unknown' };
    const fees = samples.map(s => s.fee).sort((a, b) => a - b);
    const mid = Math.floor(fees.length / 2);
    const median = fees.length % 2 ? fees[mid] : (fees[mid - 1] + fees[mid]) / 2;
    const agreeing = fees.filter(f => Math.abs(f - median) <= AGREE_TOLERANCE);
    const mean = agreeing.reduce((a, b) => a + b, 0) / agreeing.length;
    const fee = snapFee(mean);

    if (agreeing.length >= 2 && agreeing.length * 2 > fees.length) {
        return { fee, confidence: 'derived' };
    }
    return {
        fee,
        confidence: 'ambiguous',
        error: samples.length === 1
            ? 'only 1 usable swap found — need 2+ agreeing samples to confirm'
            : `only ${agreeing.length}/${fees.length} samples agree with the median — possible dynamic fee or fee-on-transfer token`,
    };
}

// -----------------------------------------------------------------------------
// Transport: HyperSync

async function makeHyperSyncClient(hs: HyperSyncConfig): Promise<{ client: any; mod: any }> {
    const mod: any = await import('@envio-dev/hypersync-client');
    const HypersyncClient = mod.HypersyncClient;
    if (!HypersyncClient) throw new Error('HypersyncClient not exported by @envio-dev/hypersync-client');
    // Same construction pattern as hypersync.ts: static factory first (older
    // bindings), plain constructor otherwise (current bindings).
    const clientConfig = { url: hs.url, apiToken: hs.apiToken, bearerToken: hs.apiToken };
    const client = typeof HypersyncClient.new === 'function'
        ? HypersyncClient.new(clientConfig)
        : new HypersyncClient(clientConfig);
    return { client, mod };
}

async function fetchLogsHyperSync(
    hs: HyperSyncConfig,
    pair: string,
): Promise<{ logs: RawLog[]; from: number; to: number; swaps: number }> {
    const { client, mod } = await makeHyperSyncClient(hs);
    const head: number = await client.getHeight();

    // Walk backward: recent first, then progressively older, then the rest
    // of history. Each window is paginated forward via nextBlock.
    const bounds = [500_000, 5_000_000, Number.MAX_SAFE_INTEGER];
    const logs: RawLog[] = [];
    let swaps = 0;
    let windowTo = head;
    let searchedFrom = head;
    const PER_WINDOW_LOG_CAP = 50_000; // runaway guard for hyperactive pairs

    for (const span of bounds) {
        if (windowTo <= 0) break;
        const windowFrom = Math.max(0, head - span);
        if (windowFrom >= windowTo) continue;

        let query: any = {
            fromBlock: windowFrom,
            toBlock: windowTo + 1, // exclusive
            logs: [{ address: [pair.toLowerCase()], topics: [[SWAP_TOPIC, SYNC_TOPIC]] }],
            fieldSelection: {
                log: ['TransactionHash', 'LogIndex', 'BlockNumber', 'Address', 'Data', 'Topic0', 'Topic1', 'Topic2'],
            },
            joinMode: mod.JoinMode?.JoinNothing ?? 2,
        };
        let windowLogs = 0;
        while (true) {
            const res: any = await client.get(query);
            for (const l of (res?.data?.logs ?? []) as any[]) {
                const topics = ((l.topics ?? []) as Array<string | null>).filter((t): t is string => !!t);
                if (topics.length === 0 || l.transactionHash == null || l.logIndex == null) continue;
                logs.push({
                    txHash: String(l.transactionHash).toLowerCase(),
                    logIndex: Number(l.logIndex),
                    blockNumber: Number(l.blockNumber ?? 0),
                    topics,
                    data: l.data ?? '0x',
                });
                if (topics[0].toLowerCase() === SWAP_TOPIC) swaps++;
                windowLogs++;
            }
            const next: number | undefined = res?.nextBlock;
            if (next == null || next >= query.toBlock || next <= query.fromBlock) break;
            if (windowLogs > PER_WINDOW_LOG_CAP) break;
            query = { ...query, fromBlock: next };
        }
        searchedFrom = windowFrom;
        windowTo = windowFrom - 1;
        if (swaps >= TARGET_SWAPS) break;
    }
    return { logs, from: searchedFrom, to: head, swaps };
}

// -----------------------------------------------------------------------------
// Transport: RPC (fallback)

const RPC_BLOCK_BUDGET = 300_000;
const RPC_MAX_REQUESTS = 200;
const RPC_CHUNK_START = 5_000;
const RPC_CHUNK_MIN = 100;
const RPC_CHUNK_MAX = 50_000;

async function fetchLogsRpc(
    provider: JsonRpcProvider,
    pair: string,
): Promise<{ logs: RawLog[]; from: number; to: number; swaps: number; error?: string }> {
    const head = await provider.getBlockNumber();
    const stopAt = Math.max(0, head - RPC_BLOCK_BUDGET);
    const logs: RawLog[] = [];
    let swaps = 0;
    let to = head;
    let requests = 0;
    let lastError: string | undefined;

    // Adaptive chunk size. Most public RPCs cap getLogs ranges (often 1k-10k
    // blocks) without saying so up front. Learn the cap by binary search
    // between the largest chunk that has worked (lastGood) and the smallest
    // that has failed (ceiling), then settle there — instead of halving once
    // and crawling at a fraction of the allowed range forever.
    let chunk = RPC_CHUNK_START;
    let lastGood = 0;
    let ceiling = Number.POSITIVE_INFINITY;

    while (to > stopAt && requests < RPC_MAX_REQUESTS && swaps < TARGET_SWAPS) {
        const from = Math.max(stopAt, to - chunk + 1);
        requests++;
        try {
            const raw = await provider.getLogs({
                address: pair,
                topics: [[SWAP_TOPIC, SYNC_TOPIC]],
                fromBlock: from,
                toBlock: to,
            });
            for (const l of raw) {
                logs.push({
                    txHash: l.transactionHash.toLowerCase(),
                    logIndex: l.index,
                    blockNumber: l.blockNumber,
                    topics: [...l.topics],
                    data: l.data,
                });
                if (l.topics[0]?.toLowerCase() === SWAP_TOPIC) swaps++;
            }
            to = from - 1;
            lastError = undefined;
            lastGood = Math.max(lastGood, chunk);
            chunk = ceiling === Number.POSITIVE_INFINITY
                ? Math.min(RPC_CHUNK_MAX, chunk * 2)
                : Math.max(lastGood, Math.floor((lastGood + ceiling + 1) / 2));
        } catch (err) {
            const raw = err as any;
            lastError = String(raw?.error?.message ?? raw?.shortMessage ?? raw?.message ?? err).slice(0, 160);
            ceiling = chunk - 1;
            if (ceiling < RPC_CHUNK_MIN) break; // failing even at the minimum — not a range issue; give up and report it
            chunk = lastGood > 0
                ? Math.min(lastGood, ceiling)
                : Math.max(RPC_CHUNK_MIN, Math.floor(chunk / 2));
        }
    }
    return { logs, from: to + 1, to: head, swaps, error: lastError };
}

// -----------------------------------------------------------------------------

/**
 * Empirically determine a pair's fee from its own swap history. Prefers
 * HyperSync when `hs` is provided; falls back to chunked RPC otherwise (or
 * if HyperSync errors). Every non-derived result says which transport ran,
 * what block range was ACTUALLY covered, and any error encountered.
 */
export async function empiricallyVerifyFee(
    provider: JsonRpcProvider,
    pairAddress: string,
    opts: { hypersync?: HyperSyncConfig } = {},
): Promise<EmpiricalFeeResult> {
    let transport: 'hypersync' | 'rpc' = 'rpc';
    let fetched: { logs: RawLog[]; from: number; to: number; swaps: number; error?: string };
    let hsError: string | undefined;

    if (opts.hypersync) {
        try {
            fetched = await fetchLogsHyperSync(opts.hypersync, pairAddress);
            transport = 'hypersync';
        } catch (err) {
            hsError = `HyperSync failed (${(err as Error).message.slice(0, 120)}), fell back to RPC`;
            fetched = await fetchLogsRpc(provider, pairAddress);
        }
    } else {
        fetched = await fetchLogsRpc(provider, pairAddress);
    }

    const base = {
        transport,
        searchedFromBlock: fetched.from,
        searchedToBlock: fetched.to,
        swapsFound: fetched.swaps,
    };
    const rangeNote = fetched.from > fetched.to
        ? `${transport} could not search any blocks`
        : `${transport} searched blocks ${fetched.from}–${fetched.to}`;
    const errNotes = [hsError, fetched.error ? `last error: ${fetched.error}` : undefined].filter(Boolean).join('; ');

    const paired = pairSwapsWithSyncs(fetched.logs)
        .sort((a, b) => b.swap.blockNumber - a.swap.blockNumber); // most recent first

    const samples: EmpiricalFeeSample[] = [];
    for (const { swap, sync } of paired) {
        const fee = recoverFee(swap, sync);
        if (fee !== null) samples.push({ txHash: swap.txHash, blockNumber: swap.blockNumber, fee });
        if (samples.length >= TARGET_SWAPS) break;
    }

    if (samples.length === 0) {
        const why = fetched.swaps === 0
            ? `0 Swap events (${rangeNote})`
            : `${fetched.swaps} Swap event(s) found but none decodable as a standard V2 swap (${rangeNote})`;
        return { ...base, fee: null, confidence: 'unknown', samples: [], error: errNotes ? `${why}; ${errNotes}` : why };
    }

    const verdict = summarize(samples);
    const error = [verdict.error, errNotes].filter(Boolean).join('; ') || undefined;
    return { ...base, fee: verdict.fee, confidence: verdict.confidence, samples, error };
}
