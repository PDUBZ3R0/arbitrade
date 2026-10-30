// -----------------------------------------------------------------------------
// Pending-swap probe: phase 1 of a pre-confirmation backrun path. MEASURES
// ONLY — nothing here builds, signs or sends a transaction.
//
// The hot loop reacts to a swap one block after it lands. On a chain with a
// public mempool the swap is visible before that: measured 2026-10-30 on
// public websockets, Sonic's pending feed showed 99% of mined transactions a
// median ~1.1s before their block, Polygon's 89% (drpc) ~0.9s ahead. A
// transaction placed right behind a big swap in the SAME block takes the
// dislocation before anyone reacting to the block can. Whether that is worth
// building depends on three things nobody has measured for our pools:
//
//   1. how often a pending swap opens a cycle in our index, and how large;
//   2. whether the swap lands while the edge is still ours to take (the
//      pending lead minus our simulate latency);
//   3. how the chain orders a same-gas-price transaction sent after the
//      victim — and whether someone already backruns these (the transaction
//      right after the victim touching the same pools says so).
//
// This answers those from live traffic. Per pending transaction:
//
//   prefilter  calldata naming one of our pairs, or two of our tokens (no RPC)
//   simulate   eth_simulateV1 on latest: the logs it WOULD emit — exact
//              post-swap reserves (Sync) or price (V3 Swap), with no router
//              ABI decoding, and aggregators handled for free
//   score      apply those logs to the live index, score the touched cycles,
//              restore — all synchronously, so the hot loop's handler can
//              never observe the shadow state
//   track      did it land, where in its block, what came straight after it,
//              and is the cycle still open once the index has the block
//
// Lives inside the hot process (`yarn arbitrage <chain> --pending-probe`)
// rather than as its own CLI because it needs exactly what that process
// already keeps current: the index, the Sync feed, pricing and thresholds. A
// second copy of that startup would be the duplication hot.ts warns about.
// -----------------------------------------------------------------------------

import { JsonRpcProvider } from 'ethers';
import type { TriangleIndex, ScoreThresholds, IndexedCandidate, V3PoolState } from './triangle-index.ts';
import type { RootPricing } from './attempt.ts';
import { decodeSync, SYNC_TOPICS, V3_SWAP_TOPIC, PANCAKE_V3_SWAP_TOPIC } from './sync-watcher.ts';
import { moveBps } from './hot-loop.ts';

export type PendingTx = {
    hash: string;
    from: string;
    to: string | null;
    input: string;
    value?: string | bigint;
    gas?: string | bigint;
    gasPrice?: string | bigint;
    maxFeePerGas?: string | bigint;
    maxPriorityFeePerGas?: string | bigint;
};

export type SimLog = { address: string; topics: string[]; data: string };

export type SimResult = {
    ok: boolean;
    error?: string;
    logs: SimLog[];
    /** The block the simulation ran on top of. */
    baseBlock: number;
};

export type LandedTx = {
    blockNumber: number;
    transactionIndex: number;
    status: number;
    effectiveGasPrice?: bigint;
    /** Block timestamp, seconds. */
    timestamp?: number;
};

/** The transaction directly after the victim in its block. */
export type NextTx = {
    hash: string;
    from: string;
    to: string | null;
    effectiveGasPrice?: bigint;
    logs: SimLog[];
};

export type PendingProbeStats = {
    seen: number;
    duplicates: number;
    /** Contract creations, plain token transfers/approvals, wrap/unwrap. */
    notASwap: number;
    /** Calldata names none of our pairs and fewer than two of our tokens. */
    filteredOut: number;
    /** Passed the prefilter but dropped: maxSimInFlight simulations already running. */
    simDropped: number;
    simulated: number;
    simErrors: number;
    /** Simulated, but the victim itself reverts at latest. */
    simReverted: number;
    /** Simulated clean and moved at least one pool in our index. */
    touchedOurPools: number;
    /** ...but no pool moved >= minMoveBps. */
    belowGate: number;
    /** V3 swaps that left the tick window the index holds: not scorable. */
    v3OutOfWindow: number;
    /** Pending swaps that opened at least one new cycle. */
    opportunities: number;
    /** Cycles that already scored before the victim — the hot loop's business, not ours. */
    standingSkipped: number;
    landed: number;
    landedReverted: number;
    notLanded: number;
    /** Landed in or before the block the simulation ran on: the sim saw it twice. */
    lateSim: number;
    /** The very next transaction in the block touched one of the cycle's pools. */
    nextTouchedPools: number;
    /** Once the index had the victim's block, the cycle still scored. */
    stillOpen: number;
    simMsTotal: number;
};

export type PendingProbeDeps = {
    index: TriangleIndex;
    thresholds: () => ScoreThresholds;
    pricing: () => RootPricing;
    decimalsByToken: Map<string, number>;
    simulate: (tx: PendingTx) => Promise<SimResult>;
    receipt: (hash: string) => Promise<LandedTx | null>;
    /** Ordering evidence. Optional: without it, nothing is said about what followed the victim. */
    nextTx?: (blockNumber: number, transactionIndex: number) => Promise<NextTx | null>;
    /** The last block the index has applied. Without it, "still open" is checked as soon as the victim lands. */
    indexedBlock?: () => number;
    /** Same gate as the hot loop. A swap that moves nothing this much cannot open a cycle. */
    minMoveBps: number;
    /**
     * Simulations running at once; beyond this a pending swap is dropped (and
     * counted). Default 8: Sonic, first run, a burst of copies of one swap hit
     * the old cap of 4 and dropped 77 in a few seconds.
     */
    maxSimInFlight?: number;
    /** How long to look for the victim's receipt, ms. Default 60s. */
    landWaitMs?: number;
    receiptPollMs?: number;
    /** One JSON object per opportunity, once its outcome is known. */
    record?: (o: Record<string, unknown>) => void;
    log?: (s: string) => void;
    now?: () => number;
};

export type PendingProbe = {
    onPending: (tx: PendingTx) => void;
    stats: () => PendingProbeStats;
    /** Resolves once every simulation and landing check started so far is done. For tests and shutdown. */
    idle: () => Promise<void>;
};

const TOKEN_OPS = new Set([
    'a9059cbb', // transfer
    '095ea7b3', // approve
    '23b872dd', // transferFrom
    'd0e30db0', // WETH deposit
    '2e1a7d4d', // WETH withdraw
]);
const SYNC_TOPIC_SET = new Set(SYNC_TOPICS);
const V3_SWAP_TOPIC_SET = new Set([V3_SWAP_TOPIC, PANCAKE_V3_SWAP_TOPIC]);

const word = (data: string, i: number): bigint => {
    const body = data.startsWith('0x') ? data.slice(2) : data;
    return BigInt('0x' + (body.slice(i * 64, i * 64 + 64) || '0'));
};
const int24 = (w: bigint): number => Number(BigInt.asIntN(24, w & 0xffffffn));

type PoolMove =
    | { kind: 'v2'; pi: number; pair: string; r0: number; r1: number; bps: number }
    | { kind: 'v3'; pi: number; pair: string; state: V3PoolState; bps: number };

type Opportunity = {
    hash: string;
    seenAt: number;
    simMs: number;
    baseBlock: number;
    moves: Array<{ pair: string; bps: number }>;
    cycles: Array<{ triangleId: number; root: string; symbol?: string; netProfit: number; value: number; pairs: string[] }>;
    gasPrice?: bigint;
};

export function createPendingProbe(deps: PendingProbeDeps): PendingProbe {
    const ix = deps.index;
    const now = deps.now ?? Date.now;
    const log = deps.log ?? ((s: string) => console.log(s));
    const maxInFlight = deps.maxSimInFlight ?? 8;
    const landWaitMs = deps.landWaitMs ?? 60_000;
    const pollMs = deps.receiptPollMs ?? 2_000;

    const stats: PendingProbeStats = {
        seen: 0, duplicates: 0, notASwap: 0, filteredOut: 0, simDropped: 0, simulated: 0, simErrors: 0,
        simReverted: 0, touchedOurPools: 0, belowGate: 0, v3OutOfWindow: 0, opportunities: 0,
        standingSkipped: 0, landed: 0, landedReverted: 0, notLanded: 0, lateSim: 0, nextTouchedPools: 0,
        stillOpen: 0, simMsTotal: 0,
    };

    // Addresses without 0x, lowercase: the prefilter scans raw calldata hex.
    const pairHex = new Set<string>([...ix.pairIdx.keys()].map(a => a.slice(2)));
    const tokenHex = new Set<string>(ix.tokenAddr.map(a => a.slice(2)));

    // A pending tx is re-announced by every peer that relays it; Gnosis'
    // feed measured heavy duplication. Bounded, oldest evicted first.
    const seenHashes = new Set<string>();
    const remember = (h: string): boolean => {
        if (seenHashes.has(h)) return false;
        seenHashes.add(h);
        if (seenHashes.size > 50_000) seenHashes.delete(seenHashes.values().next().value!);
        return true;
    };

    let inFlight = 0;
    const work = new Set<Promise<void>>();
    const track = (p: Promise<void>) => { work.add(p); p.finally(() => work.delete(p)); };

    /**
     * Does this calldata name something we trade? Every byte offset, not just
     * word boundaries: a V3 router path packs token(20) fee(3) token(20), so
     * the second token is not 32-byte aligned.
     */
    function interesting(tx: PendingTx): boolean {
        const to = tx.to?.toLowerCase();
        if (to && pairHex.has(to.slice(2))) return true;
        const input = (tx.input ?? '').toLowerCase().replace(/^0x/, '');
        const tokens = new Set<string>();
        for (let i = 8; i + 40 <= input.length; i += 2) {
            const s = input.slice(i, i + 40);
            if (pairHex.has(s)) return true;
            if (tokenHex.has(s)) { tokens.add(s); if (tokens.size >= 2) return true; }
        }
        return false;
    }

    /** The post-victim state of every pool in our index the simulation touched. Last log per pool wins. */
    function movesFrom(logs: SimLog[]): PoolMove[] {
        const byPool = new Map<number, PoolMove>();
        for (const l of logs) {
            const topic = l.topics?.[0]?.toLowerCase();
            if (!topic) continue;
            const pi = ix.pairIdx.get(l.address.toLowerCase());
            if (pi === undefined) continue;
            if (SYNC_TOPIC_SET.has(topic) && !ix.pairIsV3[pi]) {
                const d = decodeSync(l.data);
                if (!d) continue;
                byPool.set(pi, { kind: 'v2', pi, pair: ix.pairAddr[pi], r0: d.reserve0, r1: d.reserve1,
                    bps: moveBps(ix.res0[pi], ix.res1[pi], d.reserve0, d.reserve1) });
            } else if (V3_SWAP_TOPIC_SET.has(topic) && ix.pairIsV3[pi]) {
                const old = ix.v3State[pi];
                if (!old) continue;
                // A swap leaves every tick's liquidityNet alone, so the held
                // tick table stays valid — only price, active liquidity and
                // tick change. Outside the window the index holds, the float
                // hop would extrapolate into ticks it never read.
                const tick = int24(word(l.data, 4));
                if ((old.windowLow != null && tick < old.windowLow) || (old.windowHigh != null && tick > old.windowHigh)) {
                    stats.v3OutOfWindow++;
                    continue;
                }
                const sqrtPriceX96 = word(l.data, 2);
                const state: V3PoolState = { ...old, sqrtPriceX96, liquidity: word(l.data, 3), tick };
                const ratio = Number(sqrtPriceX96) / Number(old.sqrtPriceX96);
                byPool.set(pi, { kind: 'v3', pi, pair: ix.pairAddr[pi], state,
                    bps: ratio > 0 && Number.isFinite(ratio) ? Math.abs(Math.log(ratio * ratio)) * 1e4 : Infinity });
            }
        }
        return [...byPool.values()];
    }

    const rankValue = (c: IndexedCandidate): number => {
        const lc = c.rootToken.toLowerCase();
        const price = deps.pricing()[lc]?.priceInNumeraire;
        if (price == null || !(price > 0)) return -Infinity;
        return (c.netProfit / 10 ** (deps.decimalsByToken.get(lc) ?? 18)) * price;
    };

    /**
     * Score the cycles through the moved pools as they will be once the victim
     * lands. Applies the victim's state, scores, and puts the live state back
     * with no await in between: the hot loop shares this index and must never
     * score a block on a swap that has not happened.
     */
    function shadowScore(moves: PoolMove[]): { fresh: IndexedCandidate[]; standing: number; tris: Uint32Array } {
        const th = deps.thresholds();
        const tris = ix.affectedTriangles(moves.map(m => m.pi));
        const before = new Set(ix.scoreMany(tris, th).map(c => `${c.triangleId}:${c.direction}`));
        const saved = moves.map(m => m.kind === 'v2'
            ? { m, r0: ix.res0[m.pi], r1: ix.res1[m.pi] }
            : { m, st: ix.v3State[m.pi] });
        let after: IndexedCandidate[];
        try {
            for (const m of moves) {
                if (m.kind === 'v2') ix.applySync(m.pair, m.r0, m.r1);
                else ix.applyV3State(m.pair, m.state);
            }
            after = ix.scoreMany(tris, th);
        } finally {
            for (const s of saved) {
                if ('r0' in s) ix.applySync(s.m.pair, s.r0!, s.r1!);
                else ix.applyV3State(s.m.pair, s.st ?? null);
            }
        }
        const fresh = after.filter(c => !before.has(`${c.triangleId}:${c.direction}`));
        return { fresh, standing: after.length - fresh.length, tris };
    }

    async function handle(tx: PendingTx, seenAt: number): Promise<void> {
        let sim: SimResult;
        const t0 = now();
        try {
            sim = await deps.simulate(tx);
        } catch (e) {
            stats.simErrors++;
            return;
        } finally {
            inFlight--;
        }
        const simMs = now() - t0;
        stats.simulated++;
        stats.simMsTotal += simMs;
        if (!sim.ok) { stats.simReverted++; return; }

        const moves = movesFrom(sim.logs);
        if (moves.length === 0) return;
        stats.touchedOurPools++;
        if (!moves.some(m => m.bps >= deps.minMoveBps)) { stats.belowGate++; return; }

        const { fresh, standing, tris } = shadowScore(moves);
        stats.standingSkipped += standing;
        if (fresh.length === 0) return;
        stats.opportunities++;

        fresh.sort((a, b) => rankValue(b) - rankValue(a));
        const pricing = deps.pricing();
        const op: Opportunity = {
            hash: tx.hash, seenAt, simMs, baseBlock: sim.baseBlock,
            moves: moves.map(m => ({ pair: m.pair, bps: Math.round(m.bps) })),
            cycles: fresh.slice(0, 5).map(c => ({
                triangleId: c.triangleId,
                root: c.rootToken,
                symbol: pricing[c.rootToken.toLowerCase()]?.symbol,
                netProfit: c.netProfit / 10 ** (deps.decimalsByToken.get(c.rootToken.toLowerCase()) ?? 18),
                value: rankValue(c),
                pairs: c.hops.map(h => h.pair.toLowerCase()),
            })),
            gasPrice: big(tx.maxFeePerGas ?? tx.gasPrice),
        };
        const best = op.cycles[0];
        log(`  [pending] ${tx.hash.slice(0, 12)}… moves ${op.moves.map(m => `${m.pair.slice(0, 8)} ${m.bps}bps`).join(', ')}` +
            ` → ${fresh.length} new cycle(s), best ${fmt(best.netProfit)} ${best.symbol ?? best.root.slice(0, 8)}` +
            (Number.isFinite(best.value) ? ` (~${fmt(best.value)} numeraire)` : '') + ` — simulated in ${simMs}ms on block ${sim.baseBlock}`);
        await outcome(op, tris);
    }

    /** `tris` are the index's dense triangle numbers (what scoreMany takes); op.cycles carry the DB ids. */
    async function outcome(op: Opportunity, tris: Uint32Array): Promise<void> {
        const deadline = op.seenAt + landWaitMs;
        let landed: LandedTx | null = null;
        while (!landed && now() < deadline) {
            await sleep(pollMs);
            landed = await deps.receipt(op.hash).catch(() => null);
        }
        const rec: Record<string, unknown> = {
            hash: op.hash, seenAt: new Date(op.seenAt).toISOString(), simMs: op.simMs, simBaseBlock: op.baseBlock,
            moves: op.moves, cycles: op.cycles, victimGasPrice: op.gasPrice?.toString(),
        };
        if (!landed) {
            stats.notLanded++;
            rec.landed = false;
            log(`  [pending] ${op.hash.slice(0, 12)}… did not land within ${Math.round(landWaitMs / 1000)}s`);
            deps.record?.(rec);
            return;
        }
        stats.landed++;
        if (landed.status !== 1) stats.landedReverted++;
        const late = landed.blockNumber <= op.baseBlock;
        if (late) stats.lateSim++;
        Object.assign(rec, {
            landed: true, status: landed.status, block: landed.blockNumber, index: landed.transactionIndex,
            effectiveGasPrice: landed.effectiveGasPrice?.toString(),
            // Whole-second block timestamps: coarse, can read negative on fast chains. blocksAfterSim is exact.
            leadMs: landed.timestamp != null ? landed.timestamp * 1000 - op.seenAt : undefined,
            blocksAfterSim: landed.blockNumber - op.baseBlock,
            lateSim: late,
        });

        // Ordering: what did the chain put straight after the victim?
        const cyclePools = new Set(op.cycles.flatMap(c => c.pairs));
        if (deps.nextTx) {
            const next = await deps.nextTx(landed.blockNumber, landed.transactionIndex).catch(() => null);
            if (next) {
                const touched = next.logs.some(l => cyclePools.has(l.address.toLowerCase()));
                if (touched) stats.nextTouchedPools++;
                rec.next = {
                    hash: next.hash, from: next.from, to: next.to, touchedCyclePools: touched,
                    effectiveGasPrice: next.effectiveGasPrice?.toString(),
                    sameGasPrice: next.effectiveGasPrice != null && next.effectiveGasPrice === landed.effectiveGasPrice,
                };
            }
        }

        // Was it still there for the taking once the block was in? Wait (briefly)
        // for the index to apply the victim's block, then re-score the cycles.
        if (deps.indexedBlock) {
            const until = now() + 10_000;
            while (deps.indexedBlock() < landed.blockNumber && now() < until) await sleep(250);
        }
        const ids = new Set(op.cycles.map(c => c.triangleId));
        const open = ix.scoreMany(tris, deps.thresholds()).filter(c => ids.has(c.triangleId));
        if (open.length > 0) stats.stillOpen++;
        rec.stillOpenAfter = open.length > 0;

        const next = rec.next as { touchedCyclePools: boolean; sameGasPrice: boolean } | undefined;
        log(`  [pending] ${op.hash.slice(0, 12)}… landed ${landed.status === 1 ? '' : '(REVERTED) '}block ${landed.blockNumber} #${landed.transactionIndex}` +
            // Block timestamps are whole seconds: on Sonic (sub-second blocks) this
            // read -480ms on the first run. The block gap below is the real lead.
            `, ${landed.blockNumber - op.baseBlock} block(s) after our simulation base` +
            (late ? ', BEFORE our simulation base (sim was late)' : '') +
            (next ? `; next tx ${next.touchedCyclePools ? 'TOUCHED the cycle\'s pools' : 'did not touch the cycle'}` +
                (next.touchedCyclePools ? ` (${next.sameGasPrice ? 'same' : 'different'} gas price)` : '') : '') +
            `; cycle ${open.length > 0 ? 'still open' : 'closed'} after the block`);
        deps.record?.(rec);
    }

    return {
        onPending(tx) {
            stats.seen++;
            if (!tx?.hash || !remember(tx.hash.toLowerCase())) { stats.duplicates++; return; }
            const sel = (tx.input ?? '').replace(/^0x/, '').slice(0, 8).toLowerCase();
            if (!tx.to || sel.length < 8 || TOKEN_OPS.has(sel)) { stats.notASwap++; return; }
            if (!interesting(tx)) { stats.filteredOut++; return; }
            if (inFlight >= maxInFlight) { stats.simDropped++; return; }
            inFlight++;
            track(handle(tx, now()).catch(e => log(`  [pending] probe error on ${tx.hash}: ${(e as Error).message}`)));
        },
        stats: () => ({ ...stats }),
        async idle() { while (work.size) await Promise.allSettled([...work]); },
    };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const big = (v: string | bigint | undefined): bigint | undefined => v == null ? undefined : BigInt(v);
const fmt = (n: number): string => n === 0 ? '0' : Math.abs(n) >= 1 ? n.toFixed(3) : n.toPrecision(3);
const hexq = (v: string | bigint | undefined): string | undefined => v == null ? undefined : '0x' + BigInt(v).toString(16);

// --- transports --------------------------------------------------------------

/**
 * eth_simulateV1 / receipts / block ordering over one HTTP endpoint.
 *
 * Simulated with validation off: nonce, balance-for-fees and base fee are not
 * what decides whether the swap moves a pool, and with validation on a victim
 * whose nonce is one ahead of latest (a sender queueing several) would fail
 * for a reason that has nothing to do with its swap.
 */
export function rpcBackend(url: string): Pick<PendingProbeDeps, 'simulate' | 'receipt' | 'nextTx'> & { destroy: () => void } {
    const p = new JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
    const blockTs = new Map<number, number>();
    const timestamp = async (n: number): Promise<number | undefined> => {
        if (blockTs.has(n)) return blockTs.get(n);
        const b = await p.send('eth_getBlockByNumber', ['0x' + n.toString(16), false]);
        if (!b) return undefined;
        const ts = Number(b.timestamp);
        blockTs.set(n, ts);
        if (blockTs.size > 500) blockTs.delete(blockTs.keys().next().value!);
        return ts;
    };
    return {
        async simulate(tx) {
            const call = { from: tx.from, to: tx.to, input: tx.input, value: hexq(tx.value) ?? '0x0', gas: hexq(tx.gas) };
            const res = await p.send('eth_simulateV1', [{ blockStateCalls: [{ calls: [call] }], validation: false }, 'latest']);
            const b = res?.[0];
            const c = b?.calls?.[0];
            if (!c) throw new Error('eth_simulateV1 returned no call result');
            return {
                ok: Number(c.status) === 1,
                error: c.error?.message,
                logs: (c.logs ?? []).map((l: any) => ({ address: l.address, topics: l.topics, data: l.data })),
                baseBlock: Number(b.number) - 1,
            };
        },
        async receipt(hash) {
            const r = await p.send('eth_getTransactionReceipt', [hash]);
            if (!r || r.blockNumber == null) return null;
            const blockNumber = Number(r.blockNumber);
            return {
                blockNumber,
                transactionIndex: Number(r.transactionIndex),
                status: Number(r.status),
                effectiveGasPrice: r.effectiveGasPrice != null ? BigInt(r.effectiveGasPrice) : undefined,
                timestamp: await timestamp(blockNumber).catch(() => undefined),
            };
        },
        async nextTx(blockNumber, transactionIndex) {
            const t = await p.send('eth_getTransactionByBlockNumberAndIndex', ['0x' + blockNumber.toString(16), '0x' + (transactionIndex + 1).toString(16)]);
            if (!t) return null;
            const r = await p.send('eth_getTransactionReceipt', [t.hash]);
            return {
                hash: t.hash, from: t.from, to: t.to ?? null,
                effectiveGasPrice: r?.effectiveGasPrice != null ? BigInt(r.effectiveGasPrice) : undefined,
                logs: (r?.logs ?? []).map((l: any) => ({ address: l.address, topics: l.topics, data: l.data })),
            };
        },
        destroy: () => p.destroy(),
    };
}

export type PendingFeedStats = { connected: number; messages: number; fullTxs: number; hashOnly: number; fetched: number; unfetched: number; reconnects: number };

/**
 * Subscribe to newPendingTransactions on each websocket, asking for full
 * transaction objects (geth's `true` flag). publicnode honours it; drpc sends
 * hashes only (measured 2026-10-30) — those are fetched by hash over the same
 * socket, capped at maxFetchPerSec, because Polygon runs ~40 pending/s and a
 * public endpoint rate-limits long before that. A hash past the cap is
 * counted, not queued: a pending tx fetched seconds late is already mined.
 */
export function subscribePending(urls: string[], onTx: (tx: PendingTx) => void, opts: {
    maxFetchPerSec?: number;
    log?: (s: string) => void;
} = {}): { stop: () => void; stats: () => PendingFeedStats } {
    const log = opts.log ?? ((s: string) => console.log(s));
    const maxFetch = opts.maxFetchPerSec ?? 10;
    const stats: PendingFeedStats = { connected: 0, messages: 0, fullTxs: 0, hashOnly: 0, fetched: 0, unfetched: 0, reconnects: 0 };
    let stopped = false;
    const sockets: WebSocket[] = [];

    const open = (url: string, attempt: number) => {
        if (stopped) return;
        const ws = new WebSocket(url);
        sockets.push(ws);
        let subId: string | null = null;
        let nextId = 2;
        let bucket = maxFetch, bucketAt = Date.now();
        ws.onopen = () => {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newPendingTransactions', true] }));
        };
        ws.onmessage = (ev) => {
            let j: any;
            try { j = JSON.parse(String(ev.data)); } catch { return; }
            if (j.id === 1) {
                if (j.error) { log(`  [!] pending subscription refused by ${url}: ${j.error.message}`); ws.close(); return; }
                subId = j.result;
                stats.connected++;
                attempt = 0;
                return;
            }
            if (j.id != null && j.result && typeof j.result === 'object') { stats.fetched++; onTx(j.result); return; }
            if (j.method !== 'eth_subscription' || j.params?.subscription !== subId) return;
            stats.messages++;
            const r = j.params.result;
            if (r && typeof r === 'object') { stats.fullTxs++; onTx(r); return; }
            if (typeof r !== 'string') return;
            stats.hashOnly++;
            const t = Date.now();
            bucket = Math.min(maxFetch, bucket + ((t - bucketAt) / 1000) * maxFetch);
            bucketAt = t;
            if (bucket < 1) { stats.unfetched++; return; }
            bucket--;
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'eth_getTransactionByHash', params: [r] }));
        };
        ws.onerror = () => { /* onclose follows and reconnects */ };
        ws.onclose = () => {
            const i = sockets.indexOf(ws);
            if (i >= 0) sockets.splice(i, 1);
            if (subId) stats.connected--;
            if (stopped) return;
            stats.reconnects++;
            const delay = Math.min(60_000, 2_000 * 2 ** attempt);
            log(`  [!] pending feed ${url} closed; reconnecting in ${Math.round(delay / 1000)}s`);
            setTimeout(() => open(url, attempt + 1), delay).unref();
        };
    };
    for (const u of urls) open(u, 0);
    return {
        stop() { stopped = true; for (const s of [...sockets]) s.close(); },
        stats: () => ({ ...stats }),
    };
}
