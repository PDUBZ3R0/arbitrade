// -----------------------------------------------------------------------------
// Batched Multicall3 reads that survive public RPCs. Shared by every venue.
//
// Items (accounts, or any unit of work) are read `batchSize` per eth_call,
// `concurrency` calls in flight. Every item in one batch is read at the same
// block; `blockTag` pins all batches to one block so a tick's prices and
// health factors agree.
//
// Items whose calls fail are omitted from the result (and counted), never
// returned with made-up zeros — a zero HF would look liquidatable.
//
// WHEN A WHOLE BATCH FAILS. Health reads are expensive (Aave's
// getUserAccountData loops every reserve and asks the oracle for each price,
// ~100k+ gas on a 14-reserve market) and public endpoints cap eth_call gas
// well below what 100 of them need. Running out of gas inside aggregate3
// reverts with NO data ("missing revert data"), which is what the first
// Optimism run hit. So a failed batch is split in half and retried, down to
// single items, and the batch size that worked is carried forward
// (`batchSize` in the result) so later batches — and, via HealthMonitor, later
// ticks — start at the size the endpoint accepts instead of rediscovering it.
// Rate limits and timeouts are retried at the same size first; they say
// nothing about the batch.
//
// STATE ERRORS ARE NOT SIZE ERRORS. "historical state … is not available" /
// "Unknown state. First available state is …" / "missing trie node" mean the
// node no longer (or does not yet) hold state for the pinned `blockTag`. On
// Arbitrum's public RPC — 4 blocks/s, a few seconds of state kept — a sweep
// pinned to a block from before a 13s subgraph seed hit exactly this, and
// bisection shrank the batch to 1 account per call for nothing. Such an error
// drops the pin: the batch, and every later one in this call, is read at
// `latest` (`unpinned` in the result). Each batch is still one atomic read.
// -----------------------------------------------------------------------------

import type { JsonRpcProvider } from 'ethers';
import { multicall3, type Multicall3Call, type Multicall3Result } from '../util/multicall.ts';

export const TRANSIENT_RE = /(rate limit|too many requests|429|timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|502|503|504|gateway)/i;
export const STATE_RE = /(historical state|state .{0,80}not available|unknown state|first available state|missing trie node|header not found|unknown block|block not found|pruned)/i;

export type BatchOptions = { batchSize?: number; concurrency?: number; blockTag?: number; log?: (s: string) => void };

export type BatchResult<T> = {
    out: T[];
    failed: number;
    calls: number;
    batchSize: number;
    errors: string[];
    unpinned: boolean;
};

/**
 * Read `items` in batches. `build(item)` returns that item's calls (any
 * number); `decode(item, results)` gets exactly those results back and returns
 * the decoded value, or null for "this item failed".
 */
export async function readBatched<I, T>(
    provider: JsonRpcProvider,
    items: I[],
    build: (item: I) => Multicall3Call[],
    decode: (item: I, results: Multicall3Result[]) => T | null,
    opts: BatchOptions = {},
    label = 'item',
): Promise<BatchResult<T>> {
    let size = Math.max(1, opts.batchSize ?? 100);
    let blockTag: number | undefined = opts.blockTag;
    let unpinned = false;
    const concurrency = opts.concurrency ?? 4;
    const log = opts.log ?? (() => {});
    const out: T[] = [];
    const errors: string[] = [];
    let failed = 0, calls = 0, cursor = 0, ok = 0;

    const read = async (batch: I[]): Promise<void> => {
        const callList: Multicall3Call[] = [];
        const spans: number[] = [];
        for (const it of batch) { const c = build(it); spans.push(c.length); callList.push(...c); }
        let lastMsg = '';
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                calls++;
                const res = await multicall3(provider, callList, blockTag);
                let k = 0;
                batch.forEach((it, i) => {
                    const slice = res.slice(k, k + spans[i]);
                    k += spans[i];
                    let v: T | null = null;
                    try { v = decode(it, slice); } catch { v = null; }
                    if (v == null) failed++; else out.push(v);
                });
                ok++;
                return;
            } catch (err) {
                const e = err as any;
                lastMsg = `${e?.shortMessage ?? e?.message ?? String(err)} ${e?.info?.error?.message ?? e?.error?.message ?? ''}`.trim();
                if (STATE_RE.test(lastMsg)) {
                    if (blockTag == null) break;   // already unpinned: a real failure
                    if (!unpinned) log(`  [i] node has no state for block ${blockTag} (${lastMsg.slice(0, 60)}); reading at latest`);
                    blockTag = undefined; unpinned = true;
                    continue;
                }
                if (!TRANSIENT_RE.test(lastMsg)) break;
                await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
            }
        }
        if (batch.length === 1) {
            // Single items failing before ANY call has worked means the
            // endpoint is broken, not the batch: stop instead of issuing one
            // doomed call per item across the whole watchlist.
            if (ok === 0 && failed >= 3) throw new Error(`${label} reads failing on every call: ${lastMsg.slice(0, 200)}`);
            failed++;
            if (errors.length < 5) errors.push(`${String(batch[0])}: ${lastMsg.slice(0, 120)}`);
            return;
        }
        // A state error at `latest` is not a batch-size problem either.
        if (STATE_RE.test(lastMsg)) {
            failed += batch.length;
            if (errors.length < 5) errors.push(`${batch.length} ${label}s: ${lastMsg.slice(0, 120)}`);
            return;
        }
        const half = Math.ceil(batch.length / 2);
        if (half < size) {
            size = half;
            log(`  [i] batch of ${batch.length} rejected (${lastMsg.slice(0, 60)}); reading ${size} ${label}s per call from here`);
        }
        // Re-read in chunks of the CURRENT size, which may shrink further while
        // we go — once 5 is known to work, the rest of this batch should not
        // be retried at 18 and 9 again.
        for (let i = 0; i < batch.length;) {
            const chunk = batch.slice(i, i + Math.min(size, half));
            i += chunk.length;
            await read(chunk);
        }
    };

    const worker = async () => {
        while (cursor < items.length) {
            const batch = items.slice(cursor, cursor + size);
            cursor += batch.length;
            await read(batch);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.ceil(items.length / size)) }, worker));
    return { out, failed, calls, batchSize: size, errors, unpinned };
}
