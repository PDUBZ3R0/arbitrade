// -----------------------------------------------------------------------------
// CLI: yarn liq-watch <chain> [options]
//
// Liquidation watcher and executor for every lending venue on the chain:
//
//   aave      Aave V3 Pool           account = borrower
//   morpho    Morpho Blue singleton  account = borrower:marketId
//   compound  Compound III Comets    account = borrower:comet
//
// Read-only by default. --liquidate plans and SIMULATES liquidations (eth_call,
// free, nothing sent); only --live broadcasts, through LiquidationExecutor.
//
//   1. Borrower watchlist in db/<chain>-liq.sqlite, one set of rows per venue.
//      The first run SEEDS it, then every run tails the venue's events over
//      eth_getLogs from the last stored block. Seed sources, best first (--seed):
//        subgraph   Aave only: Aave's V3 subgraph, every account with open debt
//                   in ~1 query per 1000 borrowers. Free (GRAPH_API_KEY).
//        hypersync  every venue event since deploy (ENVIO_API_TOKEN).
//        rpc        chunked eth_getLogs from the venue's deploy block.
//      Whatever seeds it, no account is tiered on the seed's word — only on an
//      on-chain health read.
//   2. Health. Reads every borrower's health via Multicall3 with each venue's
//      own math (liquidation/aave-v3.ts, morpho.ts, compound.ts), tiers them,
//      and prints the accounts closest to liquidation.
//
// With --follow it keeps going, one tick per new block per venue: tail events,
// diff prices, re-read only the accounts that could have changed (see
// liquidation/health.ts), and print every account that crosses into `near` or
// `liquidatable`.
//
//   3. Liquidation (--liquidate / --live). For every liquidatable account worth
//      taking — at startup, the moment one crosses HF 1 under --follow, and
//      every 30s while it stays there — the venue's planner (plan.ts for Aave,
//      plan-venues.ts for Morpho / Comet) simulates candidates through the
//      deployed LiquidationExecutor and checks the best against
//      max(minProfitUsd, gas x margin). Comet collateral already sitting in
//      reserves (absorbed by someone else) is checked every minute too.
//      Needs chain.liquidator: yarn deploy-liquidator <chain> && yarn contract-update <chain>.
//
// Options:
//   --venue <list>        aave,morpho,compound or all (default: all the chain has)
//   --follow              keep watching after the initial sweep
//   --pool <addr>         Aave V3 Pool (default: liquidation.pool, else flashloan.pool)
//   --seed <source>       subgraph | hypersync | rpc. Default on an empty DB:
//                         the first one available, in that order (subgraph is
//                         Aave-only). Passing it on an existing DB re-seeds.
//   --from <block>        rpc/hypersync seed start (default: the venue's deploy block)
//   --rpc-only            same as --seed rpc
//   --top <n>             rows in the lowest-HF table (default 20)
//   --min-profit-usd <n>  dust floor (default 1): accounts whose liquidation could
//                         pay at most this much are left out of reports AND of
//                         per-block re-reads (rolling sweep only).
//   --poll-ms <n>         head polling interval for --follow (default 1000)
//   --liquidate           plan + simulate liquidations (dry run, nothing sent)
//   --live                broadcast liquidations that simulate clean (needs PRIVATE_KEY;
//                         implies --liquidate)
//   --owner <addr>        address to simulate from when PRIVATE_KEY is unset
//   --gas-margin <n>      profit must clear gas x this (default 3)
//
// Config (conf/<chain>.json5, all optional):
//   liquidation: {
//     venues: ["aave", "morpho", "compound"],
//     pool: "0x…",           // Aave Pool, when it differs from flashloan.pool
//     subgraph: "<id>",       // Aave V3 subgraph id or full URL
//     fromBlock: 123,         // Aave Pool deploy block
//     morpho: "0x…",          // Morpho Blue singleton (default: built-in per chain)
//     comets: { usdc: "0x…" },// Comets (default: built-in per chain)
//     usdOracle: "0x…",       // Aave-style oracle (getAssetPrice, 8 decimals) for USD
//                             // values; default: the Aave Pool's oracle
//     minProfitUsd: 1,
//     nearHF: 1.05, watchHF: 1.25, priceRecheckMaxHF: 2.0, bigMoveFrac: 0.10,
//     watchEvery: 10, sweepSeconds: 600, batchSize: 100, concurrency: 4,
//   }
// -----------------------------------------------------------------------------

import { loadChainConfig, type RawChainConfig } from './util/config.ts';
import { makeProvider } from './util/rpc.ts';
import { discoverDeployBlock } from './util/discover-block.ts';
import { loadAaveMarket, AaveVenue, type AaveMarket } from './liquidation/aave-v3.ts';
import { MorphoVenue, MORPHO_BLUE } from './liquidation/morpho.ts';
import { CompoundVenue, COMETS } from './liquidation/compound.ts';
import { UsdOracle } from './liquidation/usd.ts';
import { LenderBook } from './liquidation/lenders.ts';
import { LiqDB, liqDbPath, type Tier } from './liquidation/watchlist-db.ts';
import { backfillHyperSync, tailRpc } from './liquidation/events.ts';
import { resolveSubgraphUrl, seedFromSubgraph, redactUrl } from './liquidation/subgraph.ts';
import { HealthMonitor, WAD, type AccountState, type Transition } from './liquidation/health.ts';
import { Liquidator, RouteFinder, type LiquidationAttempt } from './liquidation/plan.ts';
import { VenueLiquidator, VENUE_LIQUIDATOR_ABI } from './liquidation/plan-venues.ts';
import type { Venue } from './liquidation/venue.ts';
import { dbPath } from './util/config.ts';
import { Contract, Interface, NonceManager, Wallet, formatUnits } from 'ethers';

type LiquidationConf = {
    venues?: string[];
    pool?: string;
    subgraph?: string;
    fromBlock?: number;
    morpho?: string;
    comets?: Record<string, string>;
    usdOracle?: string;
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
    console.error('Usage: yarn liq-watch <chain> [--venue aave,morpho,compound|all] [--follow] [--pool <addr>] [--seed subgraph|hypersync|rpc]');
    console.error('                              [--from <block>] [--top <n>] [--min-profit-usd <n>] [--poll-ms <n>] [--liquidate|--live]');
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
const chainId = Number(cfg.chain.id);
const liq: LiquidationConf = (cfg.raw as RawChainConfig & { liquidation?: LiquidationConf }).liquidation ?? {};
const pool = opt('--pool') ?? liq.pool ?? cfg.flashloan?.pool;
const morphoAddr = liq.morpho ?? MORPHO_BLUE[chainId]?.address;
const comets = liq.comets ?? COMETS[chainId];

type VenueName = 'aave' | 'morpho' | 'compound';
const ALL: VenueName[] = ['aave', 'morpho', 'compound'];
const has: Record<VenueName, boolean> = { aave: !!pool, morpho: !!morphoAddr, compound: !!comets && Object.keys(comets).length > 0 };
const venueArg = opt('--venue');
const wanted: VenueName[] = (() => {
    const list = venueArg ?? (liq.venues ? liq.venues.join(',') : 'all');
    if (list === 'all') return ALL.filter(v => has[v]);
    const vs = list.split(',').map(s => s.trim().toLowerCase());
    for (const v of vs) {
        if (!ALL.includes(v as VenueName)) { console.error(`--venue: unknown venue '${v}' (aave, morpho, compound, all)`); process.exit(1); }
        if (!has[v as VenueName]) {
            console.error(v === 'aave' ? `No Aave V3 Pool for ${cfg.chain.name}. Set liquidation.pool or flashloan.pool in conf/${cfg.chain.label}.json5, or pass --pool.`
                : `No ${v === 'morpho' ? 'Morpho Blue deployment' : 'Comets'} known for ${cfg.chain.name}. Set liquidation.${v === 'morpho' ? 'morpho' : 'comets'} in conf/${cfg.chain.label}.json5.`);
            process.exit(1);
        }
    }
    return vs as VenueName[];
})();
if (!wanted.length) { console.error(`No lending venue known for ${cfg.chain.name}.`); process.exit(1); }

const follow = flag('--follow');
const top = num('--top') ?? 20;
if (opt('--min-debt-usd') != null) {
    console.error('--min-debt-usd was replaced by --min-profit-usd (the most a liquidation could pay, not the debt size).');
    process.exit(1);
}
const minProfitUsd = num('--min-profit-usd') ?? liq.minProfitUsd ?? 1;
const pollMs = num('--poll-ms') ?? 1000;
const live = flag('--live');
const liquidate = live || flag('--liquidate');
if (liquidate && !cfg.chain.liquidator) {
    console.error(`--liquidate needs a deployed LiquidationExecutor for ${cfg.chain.name}:`);
    console.error(`  yarn deploy-liquidator ${cfg.chain.label} && yarn contract-update ${cfg.chain.label}`);
    process.exit(1);
}

// --- setup -------------------------------------------------------------------

const provider = makeProvider(cfg.chain);
const dbFile = liqDbPath(chainArg);
// The Aave market is loaded whenever the chain has one: its oracle prices every
// venue in USD (reports, dust floor, gas floor), even when Aave is not watched.
let market: AaveMarket | null = null;
if (pool) {
    try { market = await loadAaveMarket(provider, pool); }
    catch (e) {
        if (wanted.includes('aave')) throw e;
        console.log(`  [!] Aave Pool ${pool} did not load (${(e as Error).message.slice(0, 80)}) — no Aave oracle for USD values`);
    }
}
const usdOracleAddr = liq.usdOracle ?? market?.oracle ?? null;
const usd = new UsdOracle(provider, usdOracleAddr);
if (!usdOracleAddr) console.log('  [!] no USD oracle (no Aave Pool, no liquidation.usdOracle): only stablecoins have USD values; gas cannot be priced for liquidations');

type Track = {
    name: VenueName;
    venue: Venue;
    db: LiqDB;
    monitor: HealthMonitor;
    /** Event-seed start when nothing else says. */
    deployBlock?: number;
    deployHint?: string;
};
const healthOpts = {
    nearHF: liq.nearHF, watchHF: liq.watchHF, priceRecheckMaxHF: liq.priceRecheckMaxHF,
    bigMoveFrac: liq.bigMoveFrac, watchEvery: liq.watchEvery,
    sweepMs: liq.sweepSeconds != null ? liq.sweepSeconds * 1000 : undefined,
    batchSize: liq.batchSize, concurrency: liq.concurrency, minProfitUsd,
};
const tracks: Track[] = [];
let morphoVenue: MorphoVenue | null = null, cometVenue: CompoundVenue | null = null;
for (const name of wanted) {
    let venue: Venue, deployBlock: number | undefined, deployHint: string | undefined;
    if (name === 'aave') { venue = new AaveVenue(provider, market!); deployBlock = liq.fromBlock; deployHint = market!.pool; }
    else if (name === 'morpho') { venue = morphoVenue = new MorphoVenue(provider, morphoAddr!, usd, liq.morpho ? undefined : MORPHO_BLUE[chainId]?.deployBlock); deployBlock = venue.deployBlock; deployHint = morphoAddr; }
    else { venue = cometVenue = new CompoundVenue(provider, comets!, usd, cfg.chain.label); deployHint = Object.values(comets!)[0]; }
    await venue.init();
    const db = new LiqDB(dbFile, venue.key);
    tracks.push({ name, venue, db, deployBlock, deployHint, monitor: new HealthMonitor(provider, venue, db, healthOpts) });
}

// --- liquidation (optional) ------------------------------------------------------
let aaveLiq: Liquidator | null = null;
let venueLiq: VenueLiquidator | null = null;
let routeFinder: RouteFinder | null = null;
let signer: NonceManager | undefined;
if (liquidate) {
    // One NonceManager for every planner: two liquidations sent within ethers'
    // request cache window (250ms) would otherwise both read the same pending
    // nonce, and the second fails "nonce has already been used".
    const wallet = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY, provider) : undefined;
    signer = wallet ? new NonceManager(wallet) : undefined;
    const owner = wallet?.address ?? opt('--owner');
    if (!owner) { console.error('--liquidate needs PRIVATE_KEY (or --owner <addr> for a dry run) — the executor is owner-only, so simulations must come from its owner.'); process.exit(1); }
    if (live && !signer) { console.error('--live needs PRIVATE_KEY.'); process.exit(1); }
    const executor = cfg.chain.liquidator!;
    const onChainOwner = await new Contract(executor, VENUE_LIQUIDATOR_ABI, provider).owner().catch(() => null) as string | null;
    if (!onChainOwner) { console.error(`chain.liquidator ${executor} is not a LiquidationExecutor (owner() failed) — wrong address, or not deployed on ${cfg.chain.name}?`); process.exit(1); }
    if (onChainOwner.toLowerCase() !== owner.toLowerCase()) { console.error(`LiquidationExecutor owner is ${onChainOwner}, not ${owner} — simulations would revert NotOwner.`); process.exit(1); }

    // Exit-route hubs: the wrapped native token and the big stables, wherever a venue lists them.
    const HUB = new RegExp(`^(${[cfg.chain.token ?? 'WETH', 'WETH', 'USDC', 'USDC\\.e', 'USDT', 'USD₮0', 'DAI'].join('|')})$`, 'i');
    const hubs = [
        ...(market?.reserves.filter(r => HUB.test(r.symbol)).map(r => r.asset) ?? []),
        ...[...(cometVenue?.comets.values() ?? [])].filter(c => HUB.test(c.baseSymbol)).map(c => c.base),
    ];
    routeFinder = new RouteFinder(cfg, dbPath(chainArg), hubs);
    if (!routeFinder.available) console.log(`  [!] no ${dbPath(chainArg)} — only same-asset positions can be exited (run yarn scan ${cfg.chain.label})`);
    const plannerOpts = { executor, owner, signer, live, gasMarginMultiple: num('--gas-margin') ?? 3, minProfitUsd };
    if (market && wanted.includes('aave')) aaveLiq = new Liquidator(cfg, provider, market, routeFinder, plannerOpts);
    if (morphoVenue || cometVenue) {
        // An executor deployed before Morpho/Comet support has no such entry points.
        const code = (await provider.getCode(executor)).toLowerCase();
        const sel = (f: string) => new Interface(VENUE_LIQUIDATOR_ABI).getFunction(f)!.selector.slice(2);
        if (!code.includes(sel('liquidateMorpho')) || !code.includes(sel('liquidateComet'))) {
            console.log(`  [!] the LiquidationExecutor at ${executor} predates Morpho / Compound support — watching only.`);
            console.log(`      Redeploy: yarn deploy-liquidator ${cfg.chain.label} --redeploy && yarn contract-update ${cfg.chain.label}`);
        } else {
            const lenders = new LenderBook(provider, cfg, market?.pool ?? null, { morpho: morphoAddr });
            venueLiq = new VenueLiquidator(cfg, provider, routeFinder, lenders, usd, plannerOpts);
        }
    }
}

console.log(`Liquidation watch on ${cfg.chain.name}: ${tracks.map(t => t.venue.label).join(', ')}`);
for (const t of tracks) {
    if (t.name === 'aave') console.log(`  aave     pool ${market!.pool}, oracle ${market!.oracle}, reserves ${market!.reserves.map(r => r.symbol).join(', ')}`);
    if (t.name === 'morpho') console.log(`  morpho   ${morphoVenue!.morpho} (markets load as borrowers are seen)`);
    if (t.name === 'compound') console.log(`  compound ${[...cometVenue!.comets.values()].map(c => `c${c.name.toUpperCase()}v3 ${c.assets.map(a => a.symbol).join('/')}→${c.baseSymbol}`).join(' · ')}`);
}
console.log(`  db       ${dbFile}`);
if (liquidate) console.log(`  mode     ${live ? 'LIVE — liquidations that simulate clean are BROADCAST' : 'liquidate DRY RUN — simulate only, nothing sent'} (executor ${cfg.chain.liquidator})`);

const toUsd = (base: bigint | null): number => base == null ? 0 : Number(base) / 1e8;   // every venue reports USD x 1e8
const fmtUsd = (n: number): string =>
    n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
const fmtHf = (hf: bigint | null): string => {
    if (hf == null) return '—';
    if (hf >= 1000n * WAD) return '∞';
    return (Number(hf / 10n ** 12n) / 1e6).toFixed(4);
};
/** Account key for display: a plain address, or `address:market…` shortened to fit the table. */
const fmtAcct = (k: string): string => {
    const i = k.indexOf(':');
    return i < 0 ? k : `${k.slice(0, i)}:${k.slice(i + 1, i + 9)}…`;
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
if (seedArg === 'subgraph' && !wanted.includes('aave')) { console.error('--seed subgraph is Aave-only.'); process.exit(1); }
if (seedArg === 'hypersync' && !hypersyncOk) {
    console.error(`HyperSync needs hypersyncUrl for ${cfg.chain.name} in @chains.json5 and ENVIO_API_TOKEN in .env.`);
    process.exit(1);
}
const tailOpts = { chunk: cfg.scan.chunkStart, chunkMin: cfg.scan.chunkMin, chunkMax: cfg.scan.chunkMax, log: console.log };

const t0 = Date.now();
for (const t of tracks) {
    const seed: Seed | null = (seedArg === 'subgraph' && t.name !== 'aave' ? null : seedArg as Seed | undefined)
        ?? (t.db.lastBlock() != null ? null : t.name === 'aave' && subgraphUrl ? 'subgraph' : hypersyncOk ? 'hypersync' : 'rpc');
    if (seed === 'subgraph') {
        if (!subgraphUrl) {
            console.error(process.env.GRAPH_API_KEY
                ? `No Aave V3 subgraph known for '${cfg.chain.label}'. Set liquidation.subgraph in conf/${cfg.chain.label}.json5.`
                : 'GRAPH_API_KEY is not set. Get a free key at https://thegraph.com/studio/apikeys and add it to .env.');
            process.exit(1);
        }
        console.log(`\n[${t.venue.label}] seeding from the Aave subgraph (${redactUrl(subgraphUrl)})…`);
        const r = await seedFromSubgraph(subgraphUrl, t.db, { log: s => process.stdout.write(s) });
        const lag = head - r.block;
        console.log(`  ${r.users.toLocaleString()} borrowers in ${r.pages} quer${r.pages === 1 ? 'y' : 'ies'}, snapshot at block ${r.block}` +
            (lag > 0 ? ` (${lag.toLocaleString()} behind head — tailed below)` : ''));
    } else if (seed) {
        // rpc / hypersync replay from a start block. On a re-seed of an existing
        // DB, --from (or the config/deploy block) says where to replay from.
        let from = num('--from') ?? t.deployBlock;
        if (from == null && seed === 'rpc' && t.deployHint) {
            console.log(`  [${t.venue.label}] finding the deploy block…`);
            from = await discoverDeployBlock(provider, t.deployHint, { chainId: cfg.chain.id, explorerApiKey: process.env.ETHERSCAN_API_KEY });
        }
        from ??= 0;
        if (seed === 'hypersync') {
            console.log(`\n[${t.venue.label}] backfilling ${(head - from + 1).toLocaleString()} blocks via HyperSync…`);
            const r = await backfillHyperSync(cfg.chain.hypersyncUrl!, process.env.ENVIO_API_TOKEN!, t.db, from, head, s => process.stdout.write(s), t.venue);
            console.log(`  ${r.logs.toLocaleString()} events in ${r.calls} request(s), through block ${r.throughBlock}`);
        } else {
            console.log(`\n[${t.venue.label}] backfilling ${(head - from + 1).toLocaleString()} blocks via eth_getLogs…`);
            const r = await tailRpc(provider, t.db, from, head, { ...tailOpts, source: t.venue });
            console.log(`  ${r.logs.toLocaleString()} events in ${r.calls} getLogs call(s)`);
        }
    }
    // Catch up from wherever the seed (or the last run) left off.
    const after = t.db.lastBlock() ?? head;
    if (after < head) {
        console.log(`[${t.venue.label}] tailing ${(head - after).toLocaleString()} blocks via eth_getLogs…`);
        const r = await tailRpc(provider, t.db, after + 1, head, { ...tailOpts, source: t.venue });
        console.log(`  ${r.logs.toLocaleString()} events in ${r.calls} getLogs call(s)`);
    }
}
console.log(`Watchlist: ${tracks.map(t => `${t.venue.label} ${t.db.count().toLocaleString()}`).join(', ')} accounts through block ${head} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// --- 2. health ---------------------------------------------------------------

type Acct = Pick<AccountState, 'debtBase' | 'collateralBase' | 'config' | 'eMode' | 'hf'> & { user?: string };
const profitUsd = (t: Track, a: Acct): number => {
    const p = t.monitor.maxProfitBase(a);
    return p == null ? 0 : toUsd(p);
};
const worthIt = (t: Track, a: Acct): boolean => profitUsd(t, a) >= minProfitUsd;

const TIERS: Tier[] = ['liquidatable', 'near', 'watch', 'far', 'idle'];
const hfLabel: Record<Tier, string> = {
    liquidatable: 'HF < 1', near: `HF < ${liq.nearHF ?? 1.05}`, watch: `HF < ${liq.watchHF ?? 1.25}`, far: 'safe', idle: 'no debt',
};
const printRow = (t: Track, a: AccountState) => console.log(
    `  ${fmtAcct(a.user).padEnd(52)}  ${fmtHf(a.hf).padStart(8)}  ${fmtUsd(toUsd(a.debtBase)).padStart(9)} debt  ${fmtUsd(toUsd(a.collateralBase)).padStart(9)} coll  ` +
    `${('≤' + fmtUsd(profitUsd(t, a))).padStart(8)}  ${t.venue.describe(a)}`);

for (const t of tracks) {
    t.monitor.log = console.log;
    head = await provider.getBlockNumber();   // the seed may have taken a while
    const t1 = Date.now();
    const sweep = await t.monitor.sweep(head);
    console.log(`\n[${t.venue.label}] health sweep @ ${head}: ${sweep.read.toLocaleString()} accounts in ${sweep.calls} eth_call(s), ` +
        `${((Date.now() - t1) / 1000).toFixed(1)}s, ${t.monitor.batchSize}/call${sweep.failed ? `, ${sweep.failed} FAILED reads` : ''}`);
    console.log(`(worth it = one liquidation could pay ≥ $${minProfitUsd} before gas; "bonus" = the most one call could pay)`);
    console.log(`${'tier'.padEnd(14)}${'band'.padEnd(12)}${'accounts'.padStart(10)}${'worth it'.padStart(10)}${'debt'.padStart(12)}${'bonus'.padStart(12)}`);
    for (const tier of TIERS) {
        const rows = t.monitor.inTier(tier);
        const big = rows.filter(a => worthIt(t, a));
        const debt = big.reduce((s, a) => s + toUsd(a.debtBase), 0);
        const bonus = big.reduce((s, a) => s + profitUsd(t, a), 0);
        console.log(`${tier.padEnd(14)}${hfLabel[tier].padEnd(12)}${rows.length.toLocaleString().padStart(10)}${big.length.toLocaleString().padStart(10)}` +
            `${fmtUsd(debt).padStart(12)}${(tier === 'idle' ? '' : fmtUsd(bonus)).padStart(12)}`);
    }
    const lowest = t.monitor.inTier('liquidatable', 'near', 'watch', 'far').filter(a => worthIt(t, a)).slice(0, top);
    console.log(`Lowest health factors (could pay ≥ $${minProfitUsd}):`);
    console.log(`  ${'account'.padEnd(52)}  ${'HF'.padStart(8)}  ${'debt'.padStart(14)}  ${'collateral'.padStart(14)}  ${'bonus'.padStart(8)}  collateral → debt`);
    for (const a of lowest) printRow(t, a);
    if (!lowest.length) console.log('  (none)');
}
head = await provider.getBlockNumber();   // follow from now, not from before the sweeps

// --- liquidation attempts ------------------------------------------------------

// Per-account attempt state. A liquidation that fails the same way twice is
// backed off exponentially (30s, 1m, 2m … capped at 1h): the Optimism run found
// two accounts whose debt asset reverts every transfer ("sUSD retired") — no one
// can ever liquidate them, and retrying every 30s only slowed ticks and filled
// the log. An account that newly crosses HF 1 is always tried at once.
// A line is printed only when the outcome changes (or every 10 min as a reminder).
type TryState = { nextAt: number; fails: number; key: string; printedAt: number };
const tries = new Map<string, TryState>();
const RETRY_MS = 30_000, MAX_BACKOFF_MS = 3_600_000, REPRINT_MS = 600_000, RESERVES_MS = 60_000;
const fmtAmt = (v: bigint | undefined, dec: number) => v == null ? '?' : Number(formatUnits(v, dec)).toLocaleString(undefined, { maximumFractionDigits: 4 });
const describe = (r: LiquidationAttempt): string => {
    const b = r.best, d = b?.plan.debt;
    const cf = b && b.plan.closeFactor !== 100 ? ` cf${b.plan.closeFactor}%` : '';
    const pair = b ? `${b.plan.collateral.symbol}→${d!.symbol}${cf}` : (r.pairs[0] ? `${r.pairs[0].collateral.symbol}→${r.pairs[0].debt.symbol}` : '');
    if (r.confirmed) return `LIQUIDATED ${pair} profit ${fmtAmt(r.realisedProfit, d!.decimals)} ${d!.symbol}  tx ${r.txHash}`;
    if (r.broadcast) return `SENT, FAILED ${pair}: ${r.reason}`;
    if (r.simulated) return `simulated OK ${pair} via ${b!.route.label}: profit ${fmtAmt(b!.profit!, d!.decimals)} ${d!.symbol} (~$${r.profitUsd?.toFixed(2)}), gas ${fmtAmt(r.gasCostDebt, d!.decimals)}, floor ${fmtAmt(r.floorDebt, d!.decimals)}${live ? '' : '  [dry run]'}`;
    if (r.belowFloor) return `below floor ${pair}: profit ${fmtAmt(b!.profit!, d!.decimals)} < floor ${fmtAmt(r.floorDebt, d!.decimals)} ${d!.symbol} (gas ${fmtAmt(r.gasCostDebt, d!.decimals)})`;
    return `skip ${pair}: ${r.reason}`;
};
/** Outcome class for dedupe: same key = same story, no new line. */
const outcomeKey = (r: LiquidationAttempt): string => {
    const b = r.best, pair = b ? `${b.plan.collateral.symbol}→${b.plan.debt.symbol}` : (r.pairs[0] ? `${r.pairs[0].collateral.symbol}→${r.pairs[0].debt.symbol}` : '');
    if (r.confirmed || r.broadcast) return `sent ${r.txHash}`;
    if (r.simulated) return `ok ${pair} ${b!.route.label}`;
    if (r.belowFloor) return `below ${pair}`;
    return `skip ${pair} ${r.reason}`;
};
const fmtWait = (ms: number) => ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(0)}h` : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

/** One attempt with backoff + dedupe bookkeeping under `id`. */
const attemptOnce = async (id: string, label: string, run: () => Promise<LiquidationAttempt>, now: number) => {
    const prev = tries.get(id);
    let key: string, line: string, failed = false;
    try {
        const r = await run();
        key = outcomeKey(r);
        line = describe(r);
        failed = !r.simulated && !r.belowFloor && !r.confirmed;
        if (r.confirmed) { tries.delete(id); console.log(`  [${head}] ${label} ${line}`); return; }
    } catch (e) {
        signer?.reset();   // a send that threw may have consumed a nonce locally: re-read it from the chain
        key = `error ${(e as Error).message.slice(0, 80)}`;
        line = `attempt error: ${(e as Error).message.slice(0, 160)}`;
        failed = true;
    }
    const same = prev?.key === key;
    const fails = failed ? (same ? prev!.fails + 1 : 1) : 0;
    const wait = failed ? Math.min(MAX_BACKOFF_MS, RETRY_MS * 2 ** Math.max(0, fails - 1)) : RETRY_MS;
    // Print on a new outcome, once more when backoff starts (2nd identical failure), and every 10 min.
    const print = !same || (failed && fails === 2) || now - (prev?.printedAt ?? 0) >= REPRINT_MS;
    tries.set(id, { nextAt: now + wait, fails, key, printedAt: print ? now : prev!.printedAt });
    if (print) console.log(`  [${head}] ${label} ${line}${failed && fails > 1 ? ` (failed ${fails}x the same way; next try in ${fmtWait(wait)})` : ''}`);
};

const canLiquidate = (t: Track): boolean => t.name === 'aave' ? !!aaveLiq : !!venueLiq;
const attemptFor = (t: Track, a: AccountState): Promise<LiquidationAttempt> =>
    t.name === 'aave' ? aaveLiq!.attempt(a.user, a.hf!, a.eMode)
        : t.name === 'morpho' ? venueLiq!.attemptMorpho(morphoVenue!, a.user)
        : venueLiq!.attemptComet(cometVenue!, a.user);

/** Try liquidatable, worth-it accounts that are due (or `force`d), best payout first, at most `max`. */
const tryLiquidations = async (t: Track, force: Set<string> = new Set(), max = 3) => {
    if (!canLiquidate(t)) return;
    const now = Date.now();
    const due = t.monitor.inTier('liquidatable').filter(a => worthIt(t, a) && (force.has(a.user) || now >= (tries.get(a.user)?.nextAt ?? 0)))
        .sort((x, y) => profitUsd(t, y) - profitUsd(t, x)).slice(0, max);
    for (const a of due) await attemptOnce(a.user, `${fmtAcct(a.user).slice(0, 12)}…${t.name === 'aave' ? '' : ` [${t.name}]`}`, () => attemptFor(t, a), now);
};

/** Comet collateral already in reserves (someone else absorbed it): a standing buy, no borrower needed. */
let reservesAt = 0;
const tryReserves = async () => {
    if (!venueLiq || !cometVenue || Date.now() - reservesAt < RESERVES_MS) return;
    reservesAt = Date.now();
    let list: Awaited<ReturnType<VenueLiquidator['buyableReserves']>>;
    try { list = await venueLiq.buyableReserves(cometVenue); }
    catch (e) { console.log(`  [!] comet reserves read: ${(e as Error).message.slice(0, 120)}`); return; }
    await usd.refresh(list.map(x => x.asset.asset));
    const now = Date.now();
    for (const x of list) {
        const v = usd.value(x.asset.asset, x.reserve);
        if (v != null && toUsd(v * cometVenue.discount(x.comet, x.asset) / WAD) < minProfitUsd) continue;   // the discount on it is dust
        const id = `reserves:${x.comet.comet}:${x.asset.asset}`;
        if (now < (tries.get(id)?.nextAt ?? 0)) continue;
        await attemptOnce(id, `c${x.comet.name.toUpperCase()}v3 reserves ${fmtAmt(x.reserve, usd.decimals(x.asset.asset))} ${x.asset.symbol}`,
            () => venueLiq!.attemptComet(cometVenue!, `reserves:${x.comet.comet}`, x.asset.asset), now);
    }
};

if (liquidate) {
    for (const t of tracks) {
        if (!canLiquidate(t)) continue;
        const n = t.monitor.inTier('liquidatable').filter(a => worthIt(t, a)).length;
        console.log(`\n[${t.venue.label}] liquidation ${live ? 'attempts' : 'simulations'}: ${n} liquidatable account${n === 1 ? '' : 's'} worth ≥ $${minProfitUsd}`);
        await tryLiquidations(t, new Set(), 10);
    }
    await tryReserves();
}

const closeAll = () => { routeFinder?.close(); for (const t of tracks) t.db.close(); };
if (!follow) {
    closeAll();
    process.exit(0);
}

// --- follow ------------------------------------------------------------------

console.log(`\nFollowing (poll ${pollMs}ms). Ctrl-C to stop.`);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });   // podman / docker stop

const ALERT: Tier[] = ['liquidatable', 'near'];
const report = (t: Track, tr: Transition) => {
    if (!ALERT.includes(tr.to) && !(tr.from && ALERT.includes(tr.from))) return;
    if (!worthIt(t, { ...tr.account, user: tr.user })) return;
    const tag = tr.to === 'liquidatable' ? 'LIQUIDATABLE' : tr.to === 'near' ? 'near' : `left ${tr.from}`;
    console.log(`  [${head}] ${tag.padEnd(12)} ${fmtAcct(tr.user)}  HF ${fmtHf(tr.account.hf)}  ${fmtUsd(toUsd(tr.account.debtBase))} debt  ` +
        `≤${fmtUsd(profitUsd(t, { ...tr.account, user: tr.user }))} bonus  ${t.venue.describe({ user: tr.user, config: tr.account.config })}${tracks.length > 1 ? `  (${t.venue.label})` : ''}`);
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
    for (const t of tracks) {
        try {
            const ev = await tailRpc(provider, t.db, (t.db.lastBlock() ?? head - 1) + 1, head, { chunk: cfg.scan.chunkStart, log: console.log, source: t.venue });
            const rep = await t.monitor.tick(head, ev.touched);
            for (const tr of rep.transitions) report(t, tr);
            // Newly liquidatable accounts go first, immediately; others on the retry clock.
            await tryLiquidations(t, new Set(rep.transitions.filter(x => x.to === 'liquidatable').map(x => x.user)));
            readSince += rep.read;
            if (rep.sweepCompleted) cycles++;
        } catch (e) {
            console.log(`  [!] ${t.venue.label} tick ${head}: ${(e as Error).message.slice(0, 160)}`);
        }
    }
    await tryReserves();
    ticksSince++;
    slowestMs = Math.max(slowestMs, Date.now() - tickStart);
    if (Date.now() - lastBeat >= 60_000) {
        const n = (tier: Tier) => tracks.reduce((s, t) => s + t.monitor.inTier(tier).filter(a => worthIt(t, a)).length, 0);
        console.log(`  [${head}] ${ticksSince} ticks / ${head - beatStartBlock} blocks, slowest ${(slowestMs / 1000).toFixed(1)}s, ` +
            `${readSince} reads/min${cycles ? ` (${cycles} sweep cycle${cycles > 1 ? 's' : ''} done)` : ''} · ` +
            `liquidatable ${n('liquidatable')} · near ${n('near')} · watch ${n('watch')} (worth ≥$${minProfitUsd}) · ` +
            `${tracks.map(t => `${t.db.count()} ${t.name}`).join(' / ')} tracked`);
        lastBeat = Date.now(); readSince = 0; ticksSince = 0; beatStartBlock = head; slowestMs = 0; cycles = 0;
    }
}
closeAll();
console.log('stopped.');
