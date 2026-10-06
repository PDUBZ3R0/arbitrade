// -----------------------------------------------------------------------------
// CLI: yarn liq-watch <chain> [options]
//
// Aave V3 liquidation watcher — pieces 1 and 2 of the liquidation module.
// Read-only: no signer, no transactions. Every call is a free eth_call.
//
//   1. Borrower watchlist in db/<chain>-liq.sqlite. The first run SEEDS it,
//      then every run tails Pool events over eth_getLogs from the last stored
//      block. Seed sources, best first (see --seed):
//        subgraph   Aave's V3 subgraph: every account with open debt, in ~1
//                   query per 1000 borrowers. Free (GRAPH_API_KEY), no
//                   getLogs limits. See liquidation/subgraph.ts.
//        hypersync  every Pool event since genesis (ENVIO_API_TOKEN).
//        rpc        chunked eth_getLogs from the Pool's deploy block.
//      Whatever seeds it, the tail and the health reads are the same, and no
//      account is tiered on the seed's word — only on an on-chain HF read.
//   2. Health factors. Reads every borrower's HF via Multicall3, tiers them,
//      and prints the accounts closest to liquidation.
//
// With --follow it keeps going, one tick per new block: tail Pool events,
// diff oracle prices, re-read only the accounts that could have changed (see
// liquidation/health.ts), and print every account that crosses into
// `near` or `liquidatable`.
//
// Options:
//   --follow              keep watching after the initial sweep
//   --pool <addr>         Aave V3 Pool (default: liquidation.pool, else flashloan.pool)
//   --seed <source>       subgraph | hypersync | rpc. Default on an empty DB:
//                         the first one available, in that order. Passing it on
//                         an existing DB re-seeds (adds accounts, keeps rows).
//   --from <block>        rpc/hypersync seed start (default: Pool deploy block)
//   --rpc-only            same as --seed rpc
//   --top <n>             rows in the lowest-HF table (default 20)
//   --min-profit-usd <n>  dust floor (default 1): accounts whose liquidation could
//                         pay at most this much — min(collateral, debt x bonus)
//                         x bonus share, an upper bound before gas — are left out
//                         of reports AND of per-block re-reads (rolling sweep only).
//                         Debt size alone is the wrong test: bad debt can owe $500
//                         against $2 of collateral and pay nothing.
//   --poll-ms <n>         head polling interval for --follow (default 1000)
//
// Config (conf/<chain>.json5, all optional):
//   liquidation: {
//     pool: "0x…",           // when it differs from flashloan.pool
//     subgraph: "<id>",       // Aave V3 subgraph id or full URL; built-in ids
//                             // cover every Aave V3 chain (liquidation/subgraph.ts)
//     fromBlock: 123,         // Pool deploy block; skips discovery on RPC-only chains
//     minProfitUsd: 1,
//     nearHF: 1.05, watchHF: 1.25, priceRecheckMaxHF: 2.0, bigMoveFrac: 0.10,
//     watchEvery: 10, sweepSeconds: 600, batchSize: 100, concurrency: 4,
//   }
// -----------------------------------------------------------------------------

import { loadChainConfig, type RawChainConfig } from './util/config.ts';
import { makeProvider } from './util/rpc.ts';
import { discoverDeployBlock } from './util/discover-block.ts';
import { loadAaveMarket, positionAssets, type AaveMarket } from './liquidation/aave-v3.ts';
import { LiqDB, liqDbPath, type Tier } from './liquidation/watchlist-db.ts';
import { backfillHyperSync, tailRpc } from './liquidation/events.ts';
import { resolveSubgraphUrl, seedFromSubgraph, redactUrl } from './liquidation/subgraph.ts';
import { HealthMonitor, WAD, type AccountState, type Transition } from './liquidation/health.ts';

type LiquidationConf = {
    pool?: string;
    subgraph?: string;
    fromBlock?: number;
    minProfitUsd?: number;
    nearHF?: number;
    watchHF?: number;
    priceRecheckMaxHF?: number;
    bigMoveFrac?: number;
    watchEvery?: number;
    sweepSeconds?: number;
    batchSize?: number;
    concurrency?: number;
};

// --- args --------------------------------------------------------------------

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn liq-watch <chain> [--follow] [--pool <addr>] [--seed subgraph|hypersync|rpc] [--from <block>]');
    console.error('                              [--top <n>] [--min-profit-usd <n>] [--poll-ms <n>]');
    process.exit(1);
}
const flag = (name: string) => args.includes(name);
const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string): number | undefined => {
    const v = opt(name);
    if (v == null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) { console.error(`${name} expects a number, got ${v}`); process.exit(1); }
    return n;
};

const cfg = loadChainConfig(chainArg);
const liq: LiquidationConf = (cfg.raw as RawChainConfig & { liquidation?: LiquidationConf }).liquidation ?? {};
const pool = opt('--pool') ?? liq.pool ?? cfg.flashloan?.pool;
if (!pool) {
    console.error(`No Aave V3 Pool for ${cfg.chain.name}. Set liquidation.pool or flashloan.pool in conf/${cfg.chain.label}.json5, or pass --pool.`);
    process.exit(1);
}
const follow = flag('--follow');
const top = num('--top') ?? 20;
if (opt('--min-debt-usd') != null) {
    console.error('--min-debt-usd was replaced by --min-profit-usd (the most a liquidation could pay, not the debt size).');
    process.exit(1);
}
const minProfitUsd = num('--min-profit-usd') ?? liq.minProfitUsd ?? 1;
const pollMs = num('--poll-ms') ?? 1000;

// --- setup -------------------------------------------------------------------

const provider = makeProvider(cfg.chain);
const market = await loadAaveMarket(provider, pool);
const db = new LiqDB(liqDbPath(chainArg), market.pool);

console.log(`Aave V3 liquidation watch on ${cfg.chain.name}`);
console.log(`  pool     ${market.pool}`);
console.log(`  oracle   ${market.oracle}  (base unit ${market.baseUnit})`);
console.log(`  reserves ${market.reserves.map(r => r.symbol).join(', ')}`);
console.log(`  db       ${liqDbPath(chainArg)}`);

const toUsd = (base: bigint | null): number => base == null ? 0 : Number(base) / Number(market.baseUnit);
const fmtUsd = (n: number): string =>
    n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
const fmtHf = (hf: bigint | null): string => {
    if (hf == null) return '—';
    if (hf >= 1000n * WAD) return '∞';
    return (Number(hf / 10n ** 12n) / 1e6).toFixed(4);
};
const assetsOf = (m: AaveMarket, config: bigint): string => {
    const p = positionAssets(m, config);
    return `${p.collateral.map(r => r.symbol).join('+') || '—'} → ${p.debt.map(r => r.symbol).join('+') || '—'}`;
};

// --- 1. watchlist ------------------------------------------------------------

let head = await provider.getBlockNumber();

type Seed = 'subgraph' | 'hypersync' | 'rpc';
const subgraphUrl = resolveSubgraphUrl(cfg.chain.label, liq.subgraph, process.env.GRAPH_API_KEY);
const hypersyncOk = !!(cfg.chain.hypersyncUrl && process.env.ENVIO_API_TOKEN);
const seedArg = flag('--rpc-only') ? 'rpc' : opt('--seed');
if (seedArg != null && !['subgraph', 'hypersync', 'rpc'].includes(seedArg)) {
    console.error(`--seed must be subgraph, hypersync or rpc (got ${seedArg})`);
    process.exit(1);
}
const seed: Seed | null = (seedArg as Seed | undefined)
    ?? (db.lastBlock() != null ? null : subgraphUrl ? 'subgraph' : hypersyncOk ? 'hypersync' : 'rpc');
if (seed === 'subgraph' && !subgraphUrl) {
    console.error(process.env.GRAPH_API_KEY
        ? `No Aave V3 subgraph known for '${cfg.chain.label}'. Set liquidation.subgraph in conf/${cfg.chain.label}.json5.`
        : 'GRAPH_API_KEY is not set. Get a free key at https://thegraph.com/studio/apikeys and add it to .env.');
    process.exit(1);
}
if (seed === 'hypersync' && !hypersyncOk) {
    console.error(`HyperSync needs hypersyncUrl for ${cfg.chain.name} in @chains.json5 and ENVIO_API_TOKEN in .env.`);
    process.exit(1);
}

const t0 = Date.now();
if (seed === 'subgraph') {
    console.log(`\nSeeding from the Aave subgraph (${redactUrl(subgraphUrl!)})…`);
    const r = await seedFromSubgraph(subgraphUrl!, db, { log: s => process.stdout.write(s) });
    const lag = head - r.block;
    console.log(`  ${r.users.toLocaleString()} borrowers in ${r.pages} quer${r.pages === 1 ? 'y' : 'ies'}, snapshot at block ${r.block}` +
        (lag > 0 ? ` (${lag.toLocaleString()} behind head — tailed below)` : ''));
} else if (seed) {
    // rpc / hypersync replay from a start block. On a re-seed of an existing
    // DB, --from (or the config/deploy block) says where to replay from.
    let from = num('--from') ?? liq.fromBlock;
    if (from == null && seed === 'rpc') {
        console.log('  finding the Pool deploy block (set liquidation.fromBlock to skip this)…');
        from = await discoverDeployBlock(provider, market.pool, { chainId: cfg.chain.id, explorerApiKey: process.env.ETHERSCAN_API_KEY });
    }
    from ??= 0;
    if (seed === 'hypersync') {
        console.log(`\nBackfilling ${(head - from + 1).toLocaleString()} blocks via HyperSync…`);
        const r = await backfillHyperSync(cfg.chain.hypersyncUrl!, process.env.ENVIO_API_TOKEN!, db, from, head,
            s => process.stdout.write(s));
        console.log(`  ${r.logs.toLocaleString()} events in ${r.calls} request(s), through block ${r.throughBlock}`);
    } else {
        console.log(`\nBackfilling ${(head - from + 1).toLocaleString()} blocks via eth_getLogs…`);
        const r = await tailRpc(provider, db, from, head, {
            chunk: cfg.scan.chunkStart, chunkMin: cfg.scan.chunkMin, chunkMax: cfg.scan.chunkMax, log: console.log,
        });
        console.log(`  ${r.logs.toLocaleString()} events in ${r.calls} getLogs call(s)`);
    }
}

// Catch up from wherever the seed (or the last run) left off.
const after = db.lastBlock() ?? head;
if (after < head) {
    console.log(`Tailing ${(head - after).toLocaleString()} blocks via eth_getLogs…`);
    const r = await tailRpc(provider, db, after + 1, head, {
        chunk: cfg.scan.chunkStart, chunkMin: cfg.scan.chunkMin, chunkMax: cfg.scan.chunkMax, log: console.log,
    });
    console.log(`  ${r.logs.toLocaleString()} events in ${r.calls} getLogs call(s)`);
}
console.log(`Watchlist: ${db.count().toLocaleString()} borrowers through block ${head} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// --- 2. health ---------------------------------------------------------------

const monitor = new HealthMonitor(provider, market, db, {
    nearHF: liq.nearHF, watchHF: liq.watchHF, priceRecheckMaxHF: liq.priceRecheckMaxHF,
    bigMoveFrac: liq.bigMoveFrac, watchEvery: liq.watchEvery,
    sweepMs: liq.sweepSeconds != null ? liq.sweepSeconds * 1000 : undefined,
    batchSize: liq.batchSize, concurrency: liq.concurrency, minProfitUsd,
});
const profitUsd = (a: Pick<AccountState, 'debtBase' | 'collateralBase' | 'config' | 'eMode' | 'hf'>): number => {
    const p = monitor.maxProfitBase(a);
    return p == null ? 0 : toUsd(p);
};
const worthIt = (a: Pick<AccountState, 'debtBase' | 'collateralBase' | 'config' | 'eMode' | 'hf'>): boolean => profitUsd(a) >= minProfitUsd;

monitor.log = console.log;

head = await provider.getBlockNumber();   // the seed may have taken a while
const t1 = Date.now();
const sweep = await monitor.sweep(head);
head = await provider.getBlockNumber();   // follow from now, not from before the sweep
console.log(`\nHealth sweep @ ${head}: ${sweep.read.toLocaleString()} accounts in ${sweep.calls} eth_call(s), ` +
    `${((Date.now() - t1) / 1000).toFixed(1)}s, ${monitor.batchSize}/call${sweep.failed ? `, ${sweep.failed} FAILED reads` : ''}`);

const TIERS: Tier[] = ['liquidatable', 'near', 'watch', 'far', 'idle'];
const hfLabel: Record<Tier, string> = {
    liquidatable: 'HF < 1', near: `HF < ${liq.nearHF ?? 1.05}`, watch: `HF < ${liq.watchHF ?? 1.25}`, far: 'safe', idle: 'no debt',
};
console.log('');
console.log(`(worth it = one liquidation could pay ≥ $${minProfitUsd} before gas; "bonus" = the most one call could pay —`);
console.log(` eMode bonus where the account is in eMode, 50% close factor on positions over $2K unless HF < 0.95)`);
console.log(`${'tier'.padEnd(14)}${'band'.padEnd(12)}${'accounts'.padStart(10)}${'worth it'.padStart(10)}${'debt'.padStart(12)}${'bonus'.padStart(12)}`);
for (const t of TIERS) {
    const rows = monitor.inTier(t);
    const big = rows.filter(worthIt);
    const debt = big.reduce((s, a) => s + toUsd(a.debtBase), 0);
    const bonus = big.reduce((s, a) => s + profitUsd(a), 0);
    console.log(`${t.padEnd(14)}${hfLabel[t].padEnd(12)}${rows.length.toLocaleString().padStart(10)}${big.length.toLocaleString().padStart(10)}` +
        `${fmtUsd(debt).padStart(12)}${(t === 'idle' ? '' : fmtUsd(bonus)).padStart(12)}`);
}

const printRow = (a: AccountState) => console.log(
    `  ${a.user}  ${fmtHf(a.hf).padStart(8)}  ${fmtUsd(toUsd(a.debtBase)).padStart(9)} debt  ${fmtUsd(toUsd(a.collateralBase)).padStart(9)} coll  ` +
    `${('≤' + fmtUsd(profitUsd(a))).padStart(8)}  ${assetsOf(market, a.config)}`);

const lowest = monitor.inTier('liquidatable', 'near', 'watch', 'far').filter(worthIt).slice(0, top);
console.log(`\nLowest health factors (could pay ≥ $${minProfitUsd}):`);
console.log(`  ${'account'.padEnd(42)}  ${'HF'.padStart(8)}  ${'debt'.padStart(14)}  ${'collateral'.padStart(14)}  ${'bonus'.padStart(8)}  collateral → debt`);
for (const a of lowest) printRow(a);
if (!lowest.length) console.log('  (none)');

if (!follow) {
    db.close();
    process.exit(0);
}

// --- follow ------------------------------------------------------------------

console.log(`\nFollowing (poll ${pollMs}ms). Ctrl-C to stop.`);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });

const ALERT: Tier[] = ['liquidatable', 'near'];
const report = (t: Transition) => {
    if (!ALERT.includes(t.to) && !(t.from && ALERT.includes(t.from))) return;
    if (!worthIt(t.account)) return;
    const tag = t.to === 'liquidatable' ? 'LIQUIDATABLE' : t.to === 'near' ? 'near' : `left ${t.from}`;
    console.log(`  [${head}] ${tag.padEnd(12)} ${t.user}  HF ${fmtHf(t.account.hf)}  ${fmtUsd(toUsd(t.account.debtBase))} debt  ≤${fmtUsd(profitUsd(t.account))} bonus  ${assetsOf(market, t.account.config)}`);
};

// Heartbeat: ticks vs blocks shows whether the loop keeps up with the chain
// (a tick always processes the latest head, so a slow tick skips blocks), and
// the slowest tick is the worst-case reaction time to a price move.
let lastBeat = Date.now(), readSince = 0, ticksSince = 0, beatStartBlock = head, slowestMs = 0, cycles = 0;
while (!stopping) {
    let h: number;
    try { h = await provider.getBlockNumber(); }
    catch (e) { console.log(`  [!] getBlockNumber: ${(e as Error).message.slice(0, 80)}`); await new Promise(r => setTimeout(r, pollMs)); continue; }
    if (h <= head) { await new Promise(r => setTimeout(r, pollMs)); continue; }
    head = h;
    const tickStart = Date.now();
    try {
        const ev = await tailRpc(provider, db, (db.lastBlock() ?? head - 1) + 1, head, { chunk: cfg.scan.chunkStart, log: console.log });
        const rep = await monitor.tick(head, ev.touched);
        for (const t of rep.transitions) report(t);
        readSince += rep.read; ticksSince++;
        if (rep.sweepCompleted) cycles++;
        slowestMs = Math.max(slowestMs, Date.now() - tickStart);
    } catch (e) {
        console.log(`  [!] tick ${head}: ${(e as Error).message.slice(0, 160)}`);
    }
    if (Date.now() - lastBeat >= 60_000) {
        const n = (t: Tier) => monitor.inTier(t).filter(worthIt).length;
        console.log(`  [${head}] ${ticksSince} ticks / ${head - beatStartBlock} blocks, slowest ${(slowestMs / 1000).toFixed(1)}s, ` +
            `${readSince} reads/min${cycles ? ` (${cycles} sweep cycle${cycles > 1 ? 's' : ''} done)` : ''} · ` +
            `liquidatable ${n('liquidatable')} · near ${n('near')} · watch ${n('watch')} (worth ≥$${minProfitUsd}) · ${db.count()} tracked`);
        lastBeat = Date.now(); readSince = 0; ticksSince = 0; beatStartBlock = head; slowestMs = 0; cycles = 0;
    }
}
db.close();
console.log('stopped.');
