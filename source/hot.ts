// -----------------------------------------------------------------------------
// CLI: yarn hot <chain> [options]
//
// The Sync-event-driven hot loop. Where `yarn orchestrator` re-evaluates every
// triangle on a timer, this subscribes to Sync(uint112,uint112) across every
// V2-style pair and re-scores only the cycles whose reserves actually changed.
//
// WHY THIS SHAPE
//
// `yarn orchestrator --loop` has a structural problem that no amount of tuning
// fixes. A full pass is fine on a small graph (Sonic, 7,892 triangles: ~140ms)
// and hopeless on a large one (Polygon, ~3.9M triangles: 65-100s measured). At
// the Polygon end, by the time a pass has decided what to trade, the reserves
// it decided from are tens of blocks old: not slow at finding opportunities,
// just slow enough that the ones it finds have already been taken.
//
// Between two consecutive blocks, a handful of pairs move. Sync tells us
// exactly which, and carries the new reserves, so the live question is "which
// cycles did this block change" rather than "what are all the opportunities".
// Measured on the Sonic index (7,892 triangles, 8,599 pairs): a full re-score
// is 0.7ms, 8 moved pairs touch 2 triangles and re-score in 0.0007ms — 1001x.
// On Polygon the ratio is far larger, because the full scan is 500x bigger
// while a block still only moves a handful of pairs.
//
// WHAT IS SHARED, AND WHY
//
// Candidate execution (build → gas → floor → simulate → broadcast → ledger) is
// NOT reimplemented here. It lives in ./orchestrator/attempt.ts and is the same
// code `yarn orchestrator` runs; printing is likewise shared via
// ./orchestrator/report.ts. Every rule in that path is a rule about not losing
// money, and two copies means every future correction has to be made twice.
//
// Triangle scoring IS a second implementation (./orchestrator/triangle-index.ts)
// — unavoidably, since the batch evaluator's object-per-pair layout cannot be
// incrementalised. That duplication is covered by a test that requires the
// index and the batch evaluator to produce byte-identical candidate sets.
//
// STARTUP still runs one full `evaluateTriangles` pass (cheap on Sonic, a
// one-off minute or so on Polygon). Not for its candidates,
// but for its rootPricing table: the per-root profit floors and the
// numeraire prices that the gas floor needs. Deriving those here independently
// is exactly how the orchestrator and the CLI ended up with four divergent
// maxRoiPct values, so the hot loop reads them from the same place.
// -----------------------------------------------------------------------------

import { Wallet, JsonRpcProvider } from 'ethers';
import { loadChainConfig, dbPath, type NormalizedFactory } from './util/config.ts';
import { ArbitradeDB } from './util/db.ts';
import { evaluateTriangles, DEFAULT_MAX_ROI_PCT } from './evaluator/evaluator.ts';
import { CandidateExecutor } from './orchestrator/attempt.ts';
import { printAttempt } from './orchestrator/report.ts';
import { TriangleIndex, type ScoreThresholds } from './orchestrator/triangle-index.ts';
import { watchSync } from './orchestrator/sync-watcher.ts';
import { createHotLoop } from './orchestrator/hot-loop.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn hot <chain> [options]');
    console.error('');
    console.error('  --live                   Broadcast candidates that simulate clean. Without this');
    console.error('                           flag nothing is ever sent. Requires PRIVATE_KEY.');
    console.error('  --ws URL                 Websocket endpoint for real push. Without it, the loop');
    console.error('                           polls the HTTP host, which costs one block of latency.');
    console.error('  --candidates N           Candidates to attempt per block (default 3). Each costs');
    console.error('                           an estimateGas + staticCall round trip.');
    console.error('  --min-profit-tokens N    Minimum profit as fraction of root token.');
    console.error(`  --max-roi-pct N          Skip candidates with off-chain ROI above N% (default ${DEFAULT_MAX_ROI_PCT}).`);
    console.error('  --gas-margin N           Require profit >= N x the measured gas cost (default 3).');
    console.error('  --cooldown-ms N          Minimum gap between broadcast attempts (default 2000).');
    console.error('  --owner ADDR             Address to simulate/sign from. Defaults to PRIVATE_KEY.');
    console.error('  --reprice-sec N          How often to re-run the evaluator for fresh per-root');
    console.error('                           pricing (default 900). 0 disables.');
    console.error('  --poll-ms N              HTTP block poll interval when --ws is absent (default 1000).');
    console.error('');
    console.error('Requires an executor deployed first: yarn deploy-flasharb <chain>,');
    console.error('then set "executor": "0x..." under the chain block in conf/<chain>.json5.');
    console.error('Requires reserves and triangles in the DB: yarn reserves <chain>, yarn triangulate <chain>.');
    process.exit(1);
}

const getStr = (f: string): string | undefined => {
    const i = args.indexOf(f);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined;
};
const hasFlag = (f: string): boolean => args.indexOf(f) >= 0;

/** Parse a numeric flag, rejecting NaN rather than letting it poison arithmetic downstream. */
const num = (flag: string, dflt: number, predicate: (n: number) => boolean, what: string): number => {
    const s = getStr(flag);
    if (s == null) return dflt;
    const v = parseFloat(s);
    // `?? dflt` would NOT catch this: NaN is neither null nor undefined, so an
    // unvalidated typo sails through and surfaces hours later as a BigInt(NaN)
    // throw mid-trade. That exact bug happened with --gas-margin.
    if (!Number.isFinite(v) || !predicate(v)) {
        console.error(`${flag} must be ${what}, got "${s}"`);
        process.exit(1);
    }
    return v;
};

const live = hasFlag('--live');
const wsUrl = getStr('--ws');
const candidatesPerBlock = num('--candidates', 3, v => v >= 1, 'at least 1');
const minProfitTokensStr = getStr('--min-profit-tokens');
const minProfitTokensOpt = minProfitTokensStr ? num('--min-profit-tokens', 0, v => v > 0, 'a positive number') : undefined;
const maxRoiPct = num('--max-roi-pct', DEFAULT_MAX_ROI_PCT, v => v > 0, 'a positive number');
const gasMarginMultiple = num('--gas-margin', 3, v => v > 0, 'a positive number');
const cooldownMs = num('--cooldown-ms', 2000, v => v >= 0, 'zero or more');
const repriceSec = num('--reprice-sec', 900, v => v >= 0, 'zero or more');
const pollMs = num('--poll-ms', 1000, v => v >= 50, 'at least 50');
const ownerArg = getStr('--owner');

const cfg = loadChainConfig(chainArg);

const provider = new JsonRpcProvider(cfg.chain.host);
let signer: Wallet | undefined;
let ownerAddress: string;
if (process.env.PRIVATE_KEY) {
    signer = new Wallet(process.env.PRIVATE_KEY, provider);
    ownerAddress = ownerArg ?? signer.address;
} else if (ownerArg) {
    ownerAddress = ownerArg;
} else {
    console.error('No PRIVATE_KEY env var and no --owner given. Need an address to simulate from');
    console.error('(and a signer if --live is set). Set PRIVATE_KEY in .env, or pass --owner 0x...');
    process.exit(1);
}
if (live && !signer) {
    console.error('--live requires PRIVATE_KEY to be set (need a signer to broadcast).');
    process.exit(1);
}
if (!cfg.chain.executor) {
    console.error(`No executor deployed for ${cfg.chain.name} (chain.executor is unset in conf/${cfg.chain.label}.json5).`);
    console.error(`Run \`yarn deploy-flasharb ${cfg.chain.label}\` first.`);
    process.exit(1);
}

const minProfitTokens = minProfitTokensOpt ?? cfg.evaluator?.minProfitTokens ?? 0.001;
const minLiquidityTokens = cfg.evaluator?.minLiquidityTokens ?? 0;
const minInputTokens = cfg.evaluator?.minInputTokens ?? 0;

console.log(`Hot loop for ${cfg.chain.name} (chain id ${cfg.chain.id})`);
console.log(`Executor:  ${cfg.chain.executor}`);
console.log(`Mode:      ${live ? 'LIVE — will broadcast clean simulations' : 'DRY RUN — simulate only, no broadcast'}`);
console.log(`Feed:      ${wsUrl ? `websocket ${wsUrl}` : `HTTP polling every ${pollMs}ms (one block of latency — pass --ws for push)`}`);
console.log(`Owner:     ${ownerAddress}`);
console.log(`Per block: up to ${candidatesPerBlock} candidate(s), ${gasMarginMultiple}x gas margin, ${maxRoiPct}% ROI cap`);
console.log('');

const dbFile = dbPath(cfg.chain.label);
const db = new ArbitradeDB(dbFile);

// --- startup: one full evaluator pass, for pricing ---------------------------
//
// Deliberately not for its candidates — the index supersedes those within a
// block. What is needed is rootPricing: the per-root profit floor the evaluator
// actually selects on, and priceInNumeraire, without which gas cannot be
// expressed in a non-numeraire root token at all.
process.stdout.write('Pricing roots (one full evaluator pass)... ');
const t0 = Date.now();
const baseline = await evaluateTriangles(cfg, dbFile, {
    limit: 5, minProfitTokens, maxRoiPct, minLiquidityTokens, minInputTokens,
});
console.log(`${Date.now() - t0}ms — ${Object.keys(baseline.rootPricing).length} root(s), ` +
    `${baseline.candidatesFound.toLocaleString()} candidate(s) in the snapshot`);

// --- build the index ---------------------------------------------------------
const factoriesByAddr = new Map<string, NormalizedFactory>();
for (const f of cfg.factories ?? []) factoriesByAddr.set(f.address.toLowerCase(), f);

process.stdout.write('Building triangle index... ');
const tIx = Date.now();
const ix = TriangleIndex.build(db, factoriesByAddr);
console.log(`${ix.triangleCount.toLocaleString()} triangles over ${ix.pairCount.toLocaleString()} pairs, ` +
    `${(ix.bytes() / 1e6).toFixed(1)} MB, ${Date.now() - tIx}ms`);

if (ix.triangleCount === 0) {
    console.error(`No triangles in the index. Run \`yarn triangulate ${cfg.chain.label}\` (and \`yarn reserves ${cfg.chain.label}\`) first.`);
    process.exit(1);
}

// --- thresholds, derived from the evaluator's own resolution ------------------
//
// Token decimals come from the DB rather than the config, because the config
// only lists flash-loanable tokens while the index spans every token in every
// pair. A token with unknown decimals defaults to 18, matching the evaluator.
const decimalsByToken = new Map<string, number>();
for (const r of (db as any).db.prepare('select address, decimals from tokens where decimals is not null').all() as Array<{ address: string; decimals: number }>) {
    decimalsByToken.set(String(r.address).toLowerCase(), Number(r.decimals));
}

function buildThresholds(pricing: typeof baseline.rootPricing): ScoreThresholds {
    const minReserveByToken = new Float64Array(ix.tokenAddr.length);
    for (let i = 0; i < ix.tokenAddr.length; i++) {
        minReserveByToken[i] = minLiquidityTokens * 10 ** (decimalsByToken.get(ix.tokenAddr[i]) ?? 18);
    }
    const minProfitByRoot = new Map<string, number>();
    const minInputByRoot = new Map<string, number>();
    for (const addr of ix.tokenAddr) {
        const d = 10 ** (decimalsByToken.get(addr) ?? 18);
        const p = pricing[addr];
        // Fall back to the flat fraction for a root the evaluator did not price
        // — same fallback the evaluator uses, so the two agree.
        minProfitByRoot.set(addr, (p?.minProfitInRootTokens ?? minProfitTokens) * d);
        minInputByRoot.set(addr, (p?.minInputInRootTokens ?? minInputTokens) * d);
    }
    return {
        minProfitByRoot,
        minInputByRoot,
        minReserveByToken,
        maxRoi: maxRoiPct / 100,
        flashPremium: cfg.flashloan?.premium ?? 0.0005,
    };
}

let thresholds = buildThresholds(baseline.rootPricing);
let pricing = baseline.rootPricing;

const executor = new CandidateExecutor(cfg, provider, pricing, {
    ownerAddress,
    live,
    signer,
    gasMarginMultiple,
    minProfitTokens,
    // Short, because this process runs for hours. See ExecutorOptions.
    gasPriceMaxAgeMs: 12_000,
});

// --- the loop ----------------------------------------------------------------
//
// The per-block handler lives in ./orchestrator/hot-loop.ts so it can be driven
// by an integration test; this file is wiring only.
let lastRepriceAt = Date.now();

const hot = createHotLoop({
    index: ix,
    db,
    // Read through functions, not captured values: repricing below swaps both,
    // and a captured copy would silently keep scoring on startup thresholds
    // forever.
    thresholds: () => thresholds,
    pricing: () => pricing,
    decimalsByToken,
    attempt: (c, d) => executor.attempt(c, d),
    report: (a) => printAttempt(cfg, a),
    candidatesPerBlock,
    cooldownMs,
});

let feedErrors = 0;
let lastFeedError = '';

const watcher = await watchSync(cfg.chain.host, wsUrl, {
    isInteresting: (pair) => ix.pairIdx.has(pair),
    onBatch: hot.onBatch,
    onError: (err, ctx) => {
        feedErrors++;
        lastFeedError = `${ctx}: ${err.message}`;
        console.error(`  [!] feed error (${ctx}): ${err.message}`);
    },
    pollMs,
});

// Refuse to start blind.
//
// watchSync primes itself with one drain before returning, so blocksDrained is
// 0 here only if that drain never succeeded — an unreachable or wrong RPC host.
// (blocksDrained, not lastBlock(): a chain legitimately sitting at block 0 is
// indistinguishable from a dead feed by block number alone.)
//
// An earlier version printed "Watching Sync from block 0" and then sat in an
// endless `failed to detect network` retry, which is the worst of both worlds:
// the process looks alive, the log looks like a quiet market, and no trade can
// ever happen. A loop with no feed is not a loop.
if (watcher.stats().blocksDrained === 0) {
    await watcher.stop();
    db.close();
    provider.destroy();
    console.error('');
    console.error(`[!] Could not read a single block from ${cfg.chain.host} — not starting.`);
    if (lastFeedError) console.error(`    Last error: ${lastFeedError}`);
    console.error(`    Check "host" under the chain block in conf/${cfg.chain.label}.json5, or pass --ws.`);
    process.exit(1);
}

console.log(`Watching Sync from block ${watcher.lastBlock()}. Ctrl+C to stop.\n`);

// --- periodic repricing ------------------------------------------------------
//
// Per-root floors and numeraire prices drift with the market. Re-running the
// full evaluator is expensive (that is the whole reason this loop exists), so
// it happens on a slow timer and only to refresh pricing — never to pick
// candidates.
if (repriceSec > 0) {
    setInterval(() => {
        void (async () => {
            try {
                const r = await evaluateTriangles(cfg, dbFile, {
                    limit: 1, minProfitTokens, maxRoiPct, minLiquidityTokens, minInputTokens,
                });
                pricing = r.rootPricing;
                thresholds = buildThresholds(pricing);
                executor.setRootPricing(pricing);
                lastRepriceAt = Date.now();
            } catch (err) {
                console.error(`  [!] reprice failed, keeping previous pricing: ${(err as Error).message}`);
            }
        })();
    }, repriceSec * 1000).unref();
}

// --- heartbeat ---------------------------------------------------------------
let lastHeartbeatBlock = watcher.lastBlock();
let quietHeartbeats = 0;

setInterval(() => {
    const s = hot.stats();
    const block = watcher.lastBlock();
    const age = ((Date.now() - lastRepriceAt) / 60_000).toFixed(0);
    console.log(`[${new Date().toISOString()}] alive — block ${block}, ` +
        `${s.batches} batch(es), ${s.trianglesRescored} triangle re-scores, ` +
        `${s.candidatesFound} candidate(s), ${s.attempts} attempt(s), ${s.confirmed} confirmed, ` +
        `pricing ${age}m old`);

    // A chain that has not advanced a block in a minute is not quiet, it is
    // gone. Say so, because the symptom of a dead feed is an absence of output
    // and an absence of output is indistinguishable from "no opportunities".
    if (block === lastHeartbeatBlock) {
        quietHeartbeats++;
        console.error(`  [!] no new block in ${quietHeartbeats} minute(s) — the feed may be dead ` +
            `(${feedErrors} feed error(s) so far` + (lastFeedError ? `, last: ${lastFeedError}` : '') + `)`);
    } else {
        quietHeartbeats = 0;
        lastHeartbeatBlock = block;
    }
}, 60_000).unref();

const shutdown = async (sig: string) => {
    console.log(`\n${sig} — stopping.`);
    await watcher.stop();
    const s = watcher.stats();
    console.log(`Drained ${s.blocksDrained} blocks, saw ${s.updatesSeen} Sync logs, kept ${s.updatesKept}, ${s.errors} error(s).`);
    const h = hot.stats();
    console.log(`${h.batches} batch(es) -> ${h.pairsApplied} pair update(s) -> ` +
        `${h.trianglesRescored} re-score(s) (of ${ix.triangleCount.toLocaleString()} total) -> ` +
        `${h.candidatesFound} candidate(s) -> ${h.attempts} attempt(s) -> ${h.confirmed} confirmed` +
        (h.cooldownSkips ? `, ${h.cooldownSkips} block(s) skipped on cooldown` : '') +
        (h.pairsUnknown ? `, ${h.pairsUnknown} update(s) for unknown pairs (re-run \`yarn reserves\`)` : ''));
    db.close();
    provider.destroy();
    process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
