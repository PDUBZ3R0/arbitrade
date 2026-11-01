// -----------------------------------------------------------------------------
// Pending-swap probe: phases 1 and 2 of a pre-confirmation backrun path.
// MEASURES ONLY — it builds our executor call to simulate it, but nothing here
// signs or sends a transaction.
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
//   backrun    (phase 2) build the executor call for the best few new cycles
//              on the victim's exact post-swap reserves, and eth_simulateV1
//              [victim, backrun] as one bundle: does it execute behind THIS
//              swap, what ArbExecuted says it made, does that clear gas
//              priced at the VICTIM's gas price (fee-ordered chains sell the
//              slot behind it at that price, not at the market's)
//   track      did it land, where in its block, what came straight after it,
//              who took the cycle's pools behind it and at what gas price (and
//              would our backrun still clear bidding over that), and is the
//              cycle still open once the index has the block
//
// Phase 1 (2026-10-30) showed why phase 2 is needed: on Polygon 14 of 19
// cycles a pending swap "opened" were still open a block later, while the
// hot loop's attempts at the same chain confirmed 0 of 130. The index's float
// score is not evidence a cycle executes; the bundle simulation is.
//
// Lives inside the hot process (`yarn arbitrage <chain> --pending-probe`)
// rather than as its own CLI because it needs exactly what that process
// already keeps current: the index, the Sync feed, pricing and thresholds. A
// second copy of that startup would be the duplication hot.ts warns about.
// -----------------------------------------------------------------------------

import { JsonRpcProvider } from 'ethers';
import type { TriangleIndex, ScoreThresholds, IndexedCandidate, V3PoolState } from './triangle-index.ts';
import type { RootPricing, BackrunPlan } from './attempt.ts';
import type { Candidate } from '../evaluator/evaluator.ts';
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
    nonce?: string | number;
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

/** The victim and our backrun simulated as one bundle, in that order, on one block. */
export type BundleResult = {
    victimOk: boolean;
    ok: boolean;
    error?: string;
    /** The revert's raw data. A custom error (InsufficientRepay…) comes back as message "execution reverted" with only this to say which. */
    errorData?: string;
    gasUsed: bigint;
    logs: SimLog[];
    baseBlock: number;
};

/** A pool's state words before and after the victim, read in one simulation: getReserves() for V2, slot0() + liquidity() for V3. */
export type PoolReads = Map<string, { pre: string[]; post: string[] }>;

/** The state a pending swap leaves its pools at, exact — what buildHops takes as postState. */
export type PostState = { reserves: Map<string, { reserve0: bigint; reserve1: bigint }>; v3: Map<string, V3PoolState> };

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
    /** Pool moves in the simulated logs that the pool's own state, read before and after the victim, does not show (see confirmMoves). */
    phantomMoves: number;
    /** The read-back failed; the logs' moves were used unconfirmed. */
    confirmErrors: number;
    /** V3 swaps that left the tick window the index holds: not scorable. */
    v3OutOfWindow: number;
    /** Pending swaps that opened at least one new cycle. */
    opportunities: number;
    /** Cycles that already scored before the victim — the hot loop's business, not ours. */
    standingSkipped: number;
    /** Opened a cycle, but the sender has earlier nonces unmined: queued, not next to land. Not backrun. */
    nonceGapped: number;
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
    /** Phase 2: cycles for which a backrun was prepared and bundle-simulated. */
    backrunsTried: number;
    /** The exact walk on the post-swap reserves did not clear the config floor. */
    backrunDecayed: number;
    /** Refused before building (known bad, executor support, funding) or the path could not be read. */
    backrunRefused: number;
    /** The victim itself reverted in the bundle: nothing to measure. */
    backrunVictimReverted: number;
    /** Our executor call reverted behind the victim. */
    backrunReverted: number;
    /**
     * The bundle was simulated on a block that already held the victim, so it
     * ran the victim twice: whatever it said is not a verdict on the backrun.
     * Taken out of the counts above once the victim's block is known.
     */
    backrunLate: number;
    /** Executed behind the victim with a realised profit... */
    backrunClean: number;
    /**
     * ...and that profit cleared the gas floor at the simulated gas, priced at
     * the victim's own gas price — what landing directly behind it costs.
     */
    backrunClearsFloor: number;
    /** ...cleared the floor at the market gas price but not at the victim's: an edge only a cheaper slot keeps. */
    backrunClearsMarketOnly: number;
    /** A tx after the victim in its block (first few positions) touched the cycle's pools: a competing backrunner. */
    competitorSeen: number;
    /** Executed backruns that would still clear the floor bidding one wei over that competitor. */
    beatsCompetitor: number;
    /** ...the competitor paid the victim's own price: no bid both beats it and stays behind the victim; arrival order decides. */
    competitorTiedVictim: number;
    backrunMsTotal: number;
};

export type PendingProbeDeps = {
    index: TriangleIndex;
    thresholds: () => ScoreThresholds;
    pricing: () => RootPricing;
    decimalsByToken: Map<string, number>;
    simulate: (tx: PendingTx) => Promise<SimResult>;
    /**
     * Read the moved pools before and after the victim, in one simulation.
     * Optional: without it the simulated logs are taken as the post-swap
     * state. Sonic needs it — see confirmMoves.
     */
    readPools?: (tx: PendingTx, pools: Array<{ pair: string; kind: 'v2' | 'v3' }>) => Promise<PoolReads>;
    /**
     * Phase 2, dry run: build our executor call on the post-swap state and
     * simulate it bundled behind the victim. Optional: without it the probe
     * only scores (phase 1).
     */
    backrun?: {
        /** Usually CandidateExecutor.prepareBackrun, bound to the DB. */
        prepare: (c: Candidate, post: PostState) => Promise<BackrunPlan>;
        bundle: (victim: PendingTx, call: { from: string; to: string; data: string }) => Promise<BundleResult>;
        /** Usually CandidateExecutor.arbExecutedProfit. */
        profitOf: (logs: SimLog[]) => bigint | null;
        /** Names a revert's custom error from its data. Optional: without it the raw data is recorded. */
        describeRevert?: (data: string) => string | null;
        /** Cycles per pending swap to build and simulate, best first. Default 3. */
        perSwap?: number;
    };
    receipt: (hash: string) => Promise<LandedTx | null>;
    /** Ordering evidence: the tx after `transactionIndex`. Optional: without it, nothing is said about what followed the victim. */
    nextTx?: (blockNumber: number, transactionIndex: number) => Promise<NextTx | null>;
    /**
     * The latest block's base fee, to turn an EIP-1559 victim's fee cap into
     * what it actually pays. Optional: without it the victim's maxFeePerGas
     * is taken as its price, which errs toward a higher floor.
     */
    baseFee?: () => Promise<bigint | null>;
    /**
     * The sender's confirmed nonce (latest), to tell a pending swap from one
     * queued behind a nonce gap. Optional: without it every swap is taken as next.
     */
    nonceOf?: (address: string) => Promise<number>;
    /** How many positions after the victim to look for a competing backrunner. Default 6. */
    competitorScan?: number;
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
    | { kind: 'v2'; pi: number; pair: string; r0: number; r1: number; raw0: bigint; raw1: bigint; bps: number }
    | { kind: 'v3'; pi: number; pair: string; state: V3PoolState; bps: number };

type Opportunity = {
    hash: string;
    seenAt: number;
    simMs: number;
    baseBlock: number;
    moves: Array<{ pair: string; bps: number }>;
    cycles: Array<{ triangleId: number; root: string; symbol?: string; netProfit: number; value: number; pairs: string[]; backrun?: Record<string, unknown> }>;
    gasPrice?: bigint;
    /** What the victim pays per gas on the base block: the bid that lands us directly behind it. */
    bid?: bigint;
    /** Per cycle (index into cycles): the plan's floor and the realised profit, to re-price against a competitor once the block is in. */
    floors: Map<number, { floorFor: NonNullable<BackrunPlan['floorFor']>; gasUsed: bigint; profit: bigint | null }>;
};

/**
 * Could a backrun have taken the slot from the competitor that did? Bidding
 * one wei over it works only while that stays below the victim: Polygon,
 * 2026-10-30, the competitor paid EXACTLY the victim's 278.6 gwei and sat
 * at +1 — one wei more would have ordered us ahead of the victim, where the
 * edge does not exist yet. At that tie the floor is the victim's price and
 * arrival order, not the bid, decides; `beats` is false because no bid wins it.
 */
export function competitorVerdict(
    f: { floorFor: NonNullable<BackrunPlan['floorFor']>; gasUsed: bigint; profit: bigint | null },
    competitorPrice: bigint,
    victimPrice: bigint | undefined,
): { floor: bigint | null; beats: boolean; tied: boolean } {
    const tied = victimPrice != null && competitorPrice >= victimPrice;
    const floor = f.floorFor(f.gasUsed, tied ? victimPrice! : competitorPrice + 1n);
    return { floor, beats: !tied && f.profit != null && floor != null && f.profit >= floor, tied };
}

/**
 * The gas price a victim pays on a block with `baseFee`. A legacy tx pays its
 * gasPrice; a 1559 tx pays min(cap, baseFee + tip). Without a base fee the
 * cap stands in — higher, so the floor errs toward skipping.
 */
export function victimGasPrice(tx: PendingTx, baseFee: bigint | null | undefined): bigint | undefined {
    const cap = big(tx.maxFeePerGas);
    if (cap == null) return big(tx.gasPrice);
    const tip = big(tx.maxPriorityFeePerGas);
    if (baseFee == null || tip == null) return cap;
    return baseFee + tip < cap ? baseFee + tip : cap;
}

export function createPendingProbe(deps: PendingProbeDeps): PendingProbe {
    const ix = deps.index;
    const now = deps.now ?? Date.now;
    const log = deps.log ?? ((s: string) => console.log(s));
    const maxInFlight = deps.maxSimInFlight ?? 8;
    const landWaitMs = deps.landWaitMs ?? 60_000;
    const pollMs = deps.receiptPollMs ?? 2_000;

    const stats: PendingProbeStats = {
        seen: 0, duplicates: 0, notASwap: 0, filteredOut: 0, simDropped: 0, simulated: 0, simErrors: 0,
        simReverted: 0, touchedOurPools: 0, belowGate: 0, phantomMoves: 0, confirmErrors: 0, v3OutOfWindow: 0, opportunities: 0,
        standingSkipped: 0, nonceGapped: 0, landed: 0, landedReverted: 0, notLanded: 0, lateSim: 0, nextTouchedPools: 0,
        stillOpen: 0, simMsTotal: 0,
        backrunsTried: 0, backrunDecayed: 0, backrunRefused: 0, backrunVictimReverted: 0,
        backrunReverted: 0, backrunLate: 0, backrunClean: 0, backrunClearsFloor: 0, backrunClearsMarketOnly: 0, backrunMsTotal: 0,
        competitorSeen: 0, beatsCompetitor: 0, competitorTiedVictim: 0,
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
                // The raw words too: the backrun is built on exact reserves (buildHops walks in BigInt).
                byPool.set(pi, { kind: 'v2', pi, pair: ix.pairAddr[pi], r0: d.reserve0, r1: d.reserve1,
                    raw0: word(l.data, 0), raw1: word(l.data, 1),
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

    /**
     * Keep only the moves the pools' own state shows, at the state it shows.
     *
     * Sonic, 2026-11-01: 443 of 897 backruns "reverted behind the victim" with
     * no revert data. The victims were arbitrage bots (0xeac0722f…) that swap,
     * find the round trip losing and undo it inside a try/catch: the tx
     * succeeds and changes nothing, and on chain it has no logs. Sonic's
     * eth_simulateV1 (every endpoint tried) still returns the undone frame's
     * logs, Sync included, so the probe built backruns on a pool state that
     * never exists and the executor's profit check reverted them —
     * InsufficientRepay, a custom error the node reports as a bare
     * "execution reverted".
     */
    function confirmMoves(moves: PoolMove[], reads: PoolReads): PoolMove[] {
        const out: PoolMove[] = [];
        for (const m of moves) {
            const r = reads.get(m.pair);
            if (!r) { out.push(m); continue; }   // that pool's read failed: the log is all there is
            if (r.pre.every((w, i) => w === r.post[i])) { stats.phantomMoves++; continue; }
            if (m.kind === 'v2') {
                const raw0 = word(r.post[0], 0), raw1 = word(r.post[0], 1);
                const r0 = Number(raw0), r1 = Number(raw1);
                out.push({ ...m, raw0, raw1, r0, r1, bps: moveBps(ix.res0[m.pi], ix.res1[m.pi], r0, r1) });
            } else {
                const old = ix.v3State[m.pi]!;
                const sqrtPriceX96 = word(r.post[0], 0), tick = int24(word(r.post[0], 1));
                if ((old.windowLow != null && tick < old.windowLow) || (old.windowHigh != null && tick > old.windowHigh)) {
                    stats.v3OutOfWindow++;
                    continue;
                }
                const ratio = Number(sqrtPriceX96) / Number(old.sqrtPriceX96);
                out.push({ ...m, state: { ...m.state, sqrtPriceX96, tick, liquidity: word(r.post[1], 0) },
                    bps: ratio > 0 && Number.isFinite(ratio) ? Math.abs(Math.log(ratio * ratio)) * 1e4 : Infinity });
            }
        }
        return out;
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
            // Gnosis, first run: 364 errors and no idea why. Say what the first few were.
            if (stats.simErrors <= 3) log(`  [pending] simulate failed on ${tx.hash.slice(0, 12)}…: ${(e as Error).message?.slice(0, 200)}`);
            return;
        } finally {
            inFlight--;
        }
        const simMs = now() - t0;
        stats.simulated++;
        stats.simMsTotal += simMs;
        if (!sim.ok) { stats.simReverted++; return; }

        let moves = movesFrom(sim.logs);
        if (moves.length === 0) return;
        stats.touchedOurPools++;
        if (!moves.some(m => m.bps >= deps.minMoveBps)) { stats.belowGate++; return; }
        if (deps.readPools) {
            try {
                moves = confirmMoves(moves, await deps.readPools(tx, moves.map(m => ({ pair: m.pair, kind: m.kind }))));
            } catch (e) {
                stats.confirmErrors++;
                if (stats.confirmErrors <= 3) log(`  [pending] pool read-back failed on ${tx.hash.slice(0, 12)}…, using the logs: ${(e as Error).message?.slice(0, 200)}`);
            }
            if (!moves.some(m => m.bps >= deps.minMoveBps)) return;
        }

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
            floors: new Map(),
        };
        const best = op.cycles[0];
        log(`  [pending] ${tx.hash.slice(0, 12)}… moves ${op.moves.map(m => `${m.pair.slice(0, 8)} ${m.bps}bps`).join(', ')}` +
            ` → ${fresh.length} new cycle(s), best ${fmt(best.netProfit)} ${best.symbol ?? best.root.slice(0, 8)}` +
            (Number.isFinite(best.value) ? ` (~${fmt(best.value)} numeraire)` : '') + ` — simulated in ${simMs}ms on block ${sim.baseBlock}`);
        // Gnosis, second run: the only opportunity in 30 minutes was nonce 17
        // from a sender whose confirmed nonce was 13. The feed relays queued
        // txs too; one that can't be mined until four others arrive is no
        // victim — a backrun sent behind it lands alone and reverts.
        if (deps.nonceOf && tx.nonce != null) {
            const confirmed = await deps.nonceOf(tx.from).catch(() => null);
            if (confirmed != null && Number(tx.nonce) > confirmed) {
                stats.nonceGapped++;
                log(`  [pending] ${tx.hash.slice(0, 12)}… is queued behind a nonce gap (nonce ${Number(tx.nonce)}, sender confirmed at ${confirmed}) — not backrun`);
                deps.record?.({ hash: tx.hash, seenAt: new Date(seenAt).toISOString(), moves: op.moves, cycles: op.cycles, nonceGap: Number(tx.nonce) - confirmed });
                return;
            }
        }
        if (deps.backrun) {
            op.bid = victimGasPrice(tx, deps.baseFee ? await deps.baseFee().catch(() => null) : null);
            await backruns(tx, moves, fresh, op);
        }
        await outcome(op, tris);
    }

    /**
     * Phase 2: for the best few new cycles, build the executor call on the
     * victim's exact post-swap state and simulate [victim, backrun] in one
     * eth_simulateV1 call — the only place that state exists before the block.
     * The contract sizes every hop from live reserves, so this answers what
     * buildHops' prediction cannot: does the cycle execute behind THIS swap,
     * what does ArbExecuted say it made, and does that clear gas.
     */
    async function backruns(tx: PendingTx, moves: PoolMove[], fresh: IndexedCandidate[], op: Opportunity): Promise<void> {
        const br = deps.backrun!;
        const post: PostState = { reserves: new Map(), v3: new Map() };
        for (const m of moves) {
            if (m.kind === 'v2') post.reserves.set(m.pair, { reserve0: m.raw0, reserve1: m.raw1 });
            else post.v3.set(m.pair, m.state);
        }
        // A reason string the node already decoded stands; a bare "execution
        // reverted" with data is a custom error (InsufficientRepay…) — name it.
        const revertText = (b: BundleResult) => !b.errorData || b.errorData === '0x' || (b.error && b.error !== 'execution reverted')
            ? b.error : `${b.error ?? 'execution reverted'}: ${br.describeRevert?.(b.errorData) ?? b.errorData}`;
        const n = Math.min(br.perSwap ?? 3, fresh.length);
        await Promise.all(fresh.slice(0, n).map(async (c, i) => {
            const t0 = now();
            const rec: Record<string, unknown> = {};
            op.cycles[i].backrun = rec;
            stats.backrunsTried++;
            const tag = `  [backrun] ${tx.hash.slice(0, 12)}… #${c.triangleId}`;
            const dec = deps.decimalsByToken.get(c.rootToken.toLowerCase()) ?? 18;
            const sym = deps.pricing()[c.rootToken.toLowerCase()]?.symbol ?? c.rootToken.slice(0, 8);
            const tok = (w: bigint) => fmt(Number(w) / 10 ** dec);
            try {
                const plan = await br.prepare(c as Candidate, post);
                if (!plan.tx) {
                    if (plan.decayReason !== undefined) { stats.backrunDecayed++; rec.result = 'decayed'; rec.reason = plan.decayReason; }
                    else { stats.backrunRefused++; rec.result = 'refused'; rec.reason = plan.error; }
                    log(`${tag} — ${rec.result}: ${String(rec.reason ?? '').slice(0, 200)}`);
                    return;
                }
                let funding = plan.funding, built = plan.built!;
                let b = await br.bundle(tx, plan.tx);
                if (b.victimOk && !b.ok && plan.fallback) {
                    // Same retry attempt() makes: the flash swap reverted, try the lender.
                    rec.flashSwapError = revertText(b);
                    ({ funding, built } = plan.fallback);
                    b = await br.bundle(tx, plan.fallback.tx);
                }
                rec.funding = funding;
                rec.expectedProfit = built.expectedProfit.toString();
                rec.ms = now() - t0;
                rec.bundleBaseBlock = b.baseBlock;
                if (!b.victimOk) { stats.backrunVictimReverted++; rec.result = 'victim-reverted'; log(`${tag} — the victim reverts in the bundle; nothing to measure`); return; }
                rec.gasUsed = b.gasUsed.toString();
                if (!b.ok) {
                    stats.backrunReverted++;
                    rec.result = 'reverted';
                    rec.reason = revertText(b);
                    log(`${tag} — REVERTS behind the victim (predicted ${tok(built.expectedProfit)} ${sym}, ${funding}` +
                        (rec.flashSwapError !== undefined ? ', after the flash swap reverted too' : '') + `): ${String(rec.reason ?? '').slice(0, 200)}`);
                    return;
                }
                const profit = br.profitOf(b.logs);
                // Priced at the victim's gas price, not the market's. Gnosis,
                // 2026-10-30: the first backruns to "clear the floor" did so at
                // the market price; the victim paid 1723 gwei, and the tx that
                // took the cycle right behind it paid 237 — ordering there is
                // by fee, so the market-price floor was a slot nobody sells.
                // Matching the victim's price is the bid that is sure to land
                // directly behind it (equal price, it was first); anything
                // lower is a bet on what the competition pays (recorded once
                // the block is in, see outcome()).
                const floorMarket = plan.floorFor!(b.gasUsed);
                const floor = op.bid != null ? plan.floorFor!(b.gasUsed, op.bid) : null;
                const clears = profit != null && floor != null && profit >= floor;
                const clearsMarket = profit != null && floorMarket != null && profit >= floorMarket;
                stats.backrunClean++;
                if (clears) stats.backrunClearsFloor++;
                else if (clearsMarket) stats.backrunClearsMarketOnly++;
                op.floors.set(i, { floorFor: plan.floorFor!, gasUsed: b.gasUsed, profit });
                Object.assign(rec, {
                    result: clears ? 'clears-floor' : clearsMarket ? 'clears-market-floor-only' : 'below-floor',
                    profit: profit?.toString(), floor: floor?.toString(), bidGasPrice: op.bid?.toString(), floorAtMarket: floorMarket?.toString(),
                });
                log(`${tag} — executes behind the victim: profit ${profit != null ? tok(profit) : '?'} ${sym} (predicted ${tok(built.expectedProfit)}), ` +
                    `gas ${b.gasUsed}, floor at the victim's ${op.bid != null ? gwei(op.bid) : '?'} gwei ${floor != null ? tok(floor) : 'unpriceable'}` +
                    ` (${floorMarket != null ? tok(floorMarket) : 'unpriceable'} at market) → ` +
                    `${clears ? 'WOULD SEND' : clearsMarket ? 'clears only at market gas — below the floor' : 'below the floor'} [${rec.ms}ms, ${funding}` +
                    (rec.flashSwapError !== undefined ? ' after the flash swap reverted' : '') + `]`);
            } catch (e) {
                stats.backrunRefused++;
                rec.result = 'error'; rec.reason = (e as Error).message?.slice(0, 240);
                log(`${tag} — error: ${rec.reason}`);
            } finally {
                stats.backrunMsTotal += now() - t0;
            }
        }));
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

        // Sonic, 2026-11-01: 15 of the 22 backruns that "reverted behind the
        // victim" after the phantom-move fix were bundled on a block the victim
        // had already landed in — the victim ran a second time on top of its
        // own swap (and whoever backran it). That is latency, not a failed
        // backrun: relabel it so 'reverted' means a backrun that failed in the
        // state it was built for.
        for (const [i, c] of op.cycles.entries()) {
            const b = c.backrun as Record<string, unknown> | undefined;
            if (!b || typeof b.bundleBaseBlock !== 'number' || b.bundleBaseBlock < landed.blockNumber) continue;
            const was = b.result as string;
            if (was === 'reverted') stats.backrunReverted--;
            else if (was === 'victim-reverted') stats.backrunVictimReverted--;
            else if (was === 'clears-floor' || was === 'clears-market-floor-only' || was === 'below-floor') {
                stats.backrunClean--;
                if (was === 'clears-floor') stats.backrunClearsFloor--;
                if (was === 'clears-market-floor-only') stats.backrunClearsMarketOnly--;
            } else continue;
            stats.backrunLate++;
            b.result = 'late';
            b.lateResult = was;
            op.floors.delete(i);
            log(`  [backrun] ${op.hash.slice(0, 12)}… #${c.triangleId} — bundled on block ${b.bundleBaseBlock}, the victim landed in ${landed.blockNumber}: '${was}' was too late to mean anything`);
        }

        // Ordering: what did the chain put straight after the victim, and who
        // (within the first few positions) took the cycle's pools? Gnosis,
        // 2026-10-30: the tx right after the victim did, at 237 gwei against
        // the victim's 1723 — the price we would have had to beat.
        const cyclePools = new Set(op.cycles.flatMap(c => c.pairs));
        let competitor: (NextTx & { offset: number }) | undefined;
        if (deps.nextTx) {
            const scan = deps.competitorScan ?? 6;
            for (let k = 0; k < scan && !competitor; k++) {
                const t = await deps.nextTx(landed.blockNumber, landed.transactionIndex + k).catch(() => null);
                if (!t) break;
                const touched = t.logs.some(l => cyclePools.has(l.address.toLowerCase()));
                if (k === 0) {
                    if (touched) stats.nextTouchedPools++;
                    rec.next = {
                        hash: t.hash, from: t.from, to: t.to, touchedCyclePools: touched,
                        effectiveGasPrice: t.effectiveGasPrice?.toString(),
                        sameGasPrice: t.effectiveGasPrice != null && t.effectiveGasPrice === landed.effectiveGasPrice,
                    };
                }
                if (touched) competitor = { ...t, offset: k + 1 };
            }
        }
        if (competitor) {
            stats.competitorSeen++;
            const px = competitor.effectiveGasPrice;
            rec.competitor = {
                hash: competitor.hash, from: competitor.from, to: competitor.to, offset: competitor.offset,
                effectiveGasPrice: px?.toString(),
                // Under fee ordering a backrunner behind the victim pays less than it.
                belowVictim: px != null && landed.effectiveGasPrice != null ? px < landed.effectiveGasPrice : undefined,
            };
            // Would each backrun still clear its floor bidding one wei over it?
            const tied = px != null && landed.effectiveGasPrice != null && px >= landed.effectiveGasPrice;
            if (tied) {
                stats.competitorTiedVictim++;
                (rec.competitor as Record<string, unknown>).tiedVictim = true;
            }
            if (px != null) for (const [i, f] of op.floors) {
                const v = competitorVerdict(f, px, landed.effectiveGasPrice);
                if (v.beats) stats.beatsCompetitor++;
                Object.assign(op.cycles[i].backrun!, { floorToBeatCompetitor: v.floor?.toString(), beatsCompetitor: v.beats, ...(v.tied ? { tiedAtVictimPrice: true } : {}) });
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
            (competitor ? `; competitor at +${competitor.offset} paid ${competitor.effectiveGasPrice != null ? gwei(competitor.effectiveGasPrice) : '?'} gwei` +
                ` (victim ${landed.effectiveGasPrice != null ? gwei(landed.effectiveGasPrice) : '?'})` +
                ((rec.competitor as Record<string, unknown>).tiedVictim ? ' — the victim\'s own price: no outbidding it from behind, arrival order decides' : '') +
                (op.floors.size ? `, ${[...op.floors.keys()].filter(i => op.cycles[i].backrun!.beatsCompetitor).length}/${op.floors.size} backrun(s) clear bidding over it` : '') : '') +
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
const gwei = (w: bigint): string => fmt(Number(w) / 1e9);
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
export function rpcBackend(url: string): Pick<PendingProbeDeps, 'simulate' | 'readPools' | 'receipt' | 'nextTx' | 'baseFee' | 'nonceOf'> & { bundle: NonNullable<PendingProbeDeps['backrun']>['bundle']; destroy: () => void } {
    const p = new JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
    const blockTs = new Map<number, number>();
    const now = Date.now;
    let baseFeeCache: bigint | null = null, baseFeeAt = 0;
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
        async bundle(victim, ours) {
            const v = { from: victim.from, to: victim.to, input: victim.input, value: hexq(victim.value) ?? '0x0', gas: hexq(victim.gas) };
            const res = await p.send('eth_simulateV1', [{ blockStateCalls: [{ calls: [v, { from: ours.from, to: ours.to, input: ours.data }] }], validation: false }, 'latest']);
            const b = res?.[0];
            const [cv, co] = b?.calls ?? [];
            if (!cv || !co) throw new Error('eth_simulateV1 returned fewer than two call results');
            return {
                victimOk: Number(cv.status) === 1,
                ok: Number(co.status) === 1,
                error: co.error?.message ?? (co.error?.data ? 'execution reverted' : undefined),
                errorData: co.error?.data,
                gasUsed: BigInt(co.gasUsed ?? 0),
                logs: (co.logs ?? []).map((l: any) => ({ address: l.address, topics: l.topics, data: l.data })),
                baseBlock: Number(b.number) - 1,
            };
        },
        async readPools(victim, pools) {
            // [reads, victim, the same reads]: before and after, in one state.
            const reads = pools.flatMap(p => p.kind === 'v2'
                ? [{ to: p.pair, input: '0x0902f1ac' }]                                   // getReserves()
                : [{ to: p.pair, input: '0x3850c7bd' }, { to: p.pair, input: '0x1a686502' }]); // slot0(), liquidity()
            const v = { from: victim.from, to: victim.to, input: victim.input, value: hexq(victim.value) ?? '0x0', gas: hexq(victim.gas) };
            const res = await p.send('eth_simulateV1', [{ blockStateCalls: [{ calls: [...reads, v, ...reads] }], validation: false }, 'latest']);
            const calls = res?.[0]?.calls;
            if (!calls || calls.length !== reads.length * 2 + 1) throw new Error('eth_simulateV1 returned the wrong number of call results');
            const out: PoolReads = new Map();
            let k = 0;
            for (const pool of pools) {
                const n = pool.kind === 'v2' ? 1 : 2;
                const pre = calls.slice(k, k + n), post = calls.slice(reads.length + 1 + k, reads.length + 1 + k + n);
                k += n;
                // A read that reverts or returns too little (a pool without slot0 — not one the index holds as V3) proves nothing either way.
                const good = (c: any) => Number(c.status) === 1 && typeof c.returnData === 'string' && c.returnData.length >= 2 + 64 * (pool.kind === 'v2' ? 2 : 1);
                if (![...pre, ...post].every(good)) continue;
                out.set(pool.pair, { pre: pre.map((c: any) => c.returnData), post: post.map((c: any) => c.returnData) });
            }
            return out;
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
        async nonceOf(address) {
            return Number(await p.send('eth_getTransactionCount', [address, 'latest']));
        },
        async baseFee() {
            // Opportunities come in bursts off one swap; one header per second is plenty.
            if (now() - baseFeeAt < 1_000) return baseFeeCache;
            const b = await p.send('eth_getBlockByNumber', ['latest', false]);
            baseFeeCache = b?.baseFeePerGas != null ? BigInt(b.baseFeePerGas) : null;
            baseFeeAt = now();
            return baseFeeCache;
        },
        destroy: () => p.destroy(),
    };
}

export type PendingFeedStats = { connected: number; messages: number; fullTxs: number; hashOnly: number; fetched: number; unfetched: number; reconnects: number; stalls: number };

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
    /**
     * A subscribed socket that delivers nothing for this long is retired and
     * reopened. Default 20s. Gnosis, 2026-10-30: publicnode's socket stopped
     * pushing mid-run without closing — the counts froze for the last ~15
     * minutes of a 45-minute run while the summary still said it was up.
     * Measured standalone after: a fresh subscription dumps ~2,600 txs (the
     * pool) in seconds, then often goes silent within 20s. With 5s blocks and
     * a mempool that is never empty, 20s of nothing is a dead socket.
     */
    stallMs?: number;
    log?: (s: string) => void;
} = {}): { stop: () => void; stats: () => PendingFeedStats } {
    const log = opts.log ?? ((s: string) => console.log(s));
    const maxFetch = opts.maxFetchPerSec ?? 10;
    const stallMs = opts.stallMs ?? 20_000;
    const stats: PendingFeedStats = { connected: 0, messages: 0, fullTxs: 0, hashOnly: 0, fetched: 0, unfetched: 0, reconnects: 0, stalls: 0 };
    let stopped = false;
    // Live sockets and whether each is subscribed. `connected` is counted from
    // this, not kept as a running total: the running total read "3 feed(s) up"
    // for one URL after a few reconnects on the same run.
    const sockets = new Map<WebSocket, { subscribed: boolean }>();
    const timers: ReturnType<typeof setInterval>[] = [];

    const open = (url: string, attempt: number) => {
        if (stopped) return;
        const ws = new WebSocket(url);
        const state = { subscribed: false };
        sockets.set(ws, state);
        let lastMsgAt = Date.now();
        let retired = false;
        // Retire this socket and open a fresh one — once, whichever of close
        // or the stall watchdog gets there first. A stalled socket's close
        // handshake may never complete, so the reopen cannot wait for onclose.
        const retire = (why: string, delay: number) => {
            if (retired) return;
            retired = true;
            clearInterval(watchdog);
            timers.splice(timers.indexOf(watchdog), 1);
            sockets.delete(ws);
            ws.onmessage = ws.onclose = ws.onerror = null;
            try { ws.close(); } catch { /* already closing */ }
            if (stopped) return;
            stats.reconnects++;
            log(`  [!] pending feed ${url} ${why}; reconnecting in ${Math.round(delay / 1000)}s`);
            setTimeout(() => open(url, attempt + 1), delay).unref();
        };
        const watchdog = setInterval(() => {
            if (state.subscribed && Date.now() - lastMsgAt > stallMs) {
                stats.stalls++;
                retire(`silent for ${Math.round((Date.now() - lastMsgAt) / 1000)}s`, 1_000);
            }
        }, Math.min(stallMs, 10_000));
        watchdog.unref();
        timers.push(watchdog);
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
                state.subscribed = true;
                lastMsgAt = Date.now();
                attempt = 0;
                return;
            }
            if (j.id != null && j.result && typeof j.result === 'object') { stats.fetched++; onTx(j.result); return; }
            if (j.method !== 'eth_subscription' || j.params?.subscription !== subId) return;
            stats.messages++;
            lastMsgAt = Date.now();
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
        ws.onclose = () => retire('closed', Math.min(60_000, 2_000 * 2 ** attempt));
    };
    for (const u of urls) open(u, 0);
    return {
        stop() {
            stopped = true;
            for (const t of timers) clearInterval(t);
            for (const s of [...sockets.keys()]) s.close();
        },
        stats: () => ({ ...stats, connected: [...sockets.values()].filter(v => v.subscribed).length }),
    };
}
