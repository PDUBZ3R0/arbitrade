// -----------------------------------------------------------------------------
// Config loader.
//
// Reads .env plus per-chain JSON5 config, and returns both:
//   - the RAW config exactly as authored (preserves nested factory structure)
//   - a NORMALIZED flat factory list convenient for the scanner
//
// This lets the config files stay compact and human-readable (grouped by DEX
// type, shared ABI declarations) while internal code gets a flat, typed list.
//
// The .env file overrides the RPC host in the JSON5 file if `${CHAIN}_RPC` is
// set, so you can commit a safe public RPC in JSON5 and keep the paid one in
// .env (never committed).
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import 'dotenv/config';
import { lookupDexPattern } from './dex-patterns.ts';
import { blacklistedAddresses } from './blacklist.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CONF_DIR = path.join(PROJECT_ROOT, 'conf');

// -----------------------------------------------------------------------------
// Types matching the on-disk shape

export type ChainMeta = {
    id: number;
    name: string;              // display name from the @chains.json5 key
    label: string;             // CLI/filesystem slug (e.g. "sonic"); also the conf/<label>.json5 filename
    currency: string;
    token?: string;            // native wrapped (WETH, WMATIC, wS...)
    host: string;              // RPC URL
    /**
     * Websocket RPC (wss://…). Used by `yarn hot` for push delivery of Sync
     * logs instead of HTTP polling; `--ws` on the command line overrides it,
     * and so does `<LABEL>_WS` in .env (same pattern as `<LABEL>_RPC`).
     * Filled in by `yarn add-chain` when chainlist lists a working one.
     */
    ws?: string;
    /** Block explorer base URL, for humans (set by `yarn add-chain`). */
    explorer?: string;
    hypersyncUrl?: string;     // Envio HyperSync URL (e.g. "https://sonic.hypersync.xyz")
    contract?: string;         // deployed YoBatches address
    executor?: string;         // deployed FlashArbExecutor address (piece 6) — set after `yarn deploy-flasharb <chain>`
    probe?: string;            // deployed TokenProbe address — set after `yarn deploy-probe <chain>` (used by `yarn probe`)
    threads?: number;
    interval?: number;
    pagesize?: number;
    alchemy?: { apikey?: string };
};

export type FactoryGroup = {
    abi: string[];             // e.g. ["event PairCreated(...)"]
    list: Record<string, string | FactoryEntry>;
};

/** When you need per-factory overrides, use this form in the config. */
export type FactoryEntry = {
    address: string;
    deployBlock?: number;

    // --- Concentrated-liquidity (v3 group) ---

    /**
     * Which creation event the factory emits (see source/util/pool-events.ts):
     *   "uniswap"     PoolCreated(token0, token1, uint24 indexed fee, int24 tickSpacing, pool)
     *                 — Uniswap V3, PancakeV3 and most forks. Default.
     *   "tickspacing" PoolCreated(token0, token1, int24 indexed tickSpacing, pool)
     *                 — factories keyed by spacing with the fee set per pool.
     * verify-v3-factory measures this; copy it from its snippet.
     *
     * solidly group: "velodrome" for factories that announce pools with
     *   PoolCreated(token0, token1, bool indexed stable, pool, uint256)
     *   — Velodrome V2 / Aerodrome V2 — instead of Solidly's PairCreated.
     *   Omit for classic Solidly.
     */
    poolEvent?: 'uniswap' | 'tickspacing' | 'velodrome';
    /**
     * Swap callback the factory's pools call on the swapper, as found in the
     * pool bytecode by verify-v3-factory (e.g. "uniswapV3SwapCallback",
     * "pancakeV3SwapCallback"). The executor must implement this to pay the pool.
     */
    callback?: string;
    /** Factory-wide fee for pure v2 (unused for v2fee/solidly — those use per-pair). */
    fee?: number;

    /**
     * Static per-pair-type fees. When set, this factory has fees hardcoded
     * in swap() based on pair.stable — not queryable via any view function.
     * Metadata step applies stable/volatile fee based on pair's stable flag,
     * no on-chain calls. Overrides `fee`; ignored if `feeFunction` is set.
     * Example: WhaleSwap on Polygon.
     */
    stableFees?: { stable: number; volatile: number };

    // --- Per-pair fee metadata (v2fee / solidly groups) ---

    /**
     * Where the fee lookup function lives:
     *   "factory" (default): call factory.<feeFunction>(pair)  — Shadow, Equalizer
     *   "pair":              call pair.<feeFunction>()         — DXSwap
     */
    feeTarget?: 'factory' | 'pair';
    /**
     * When feeTarget="factory", what to pass as the function argument:
     *   "pair-address" (default) — factory.<feeFunction>(pair)      — Shadow, Equalizer, DXSwap-style
     *   "pair-stable"            — factory.<feeFunction>(pair.stable) — PairFactoryUpgradeable
     *                                                                  (Retro-family), returns fee
     *                                                                  for stable vs volatile pool
     * Ignored when feeTarget="pair" (zero-arg call).
     */
    feeArgSource?: 'pair-address' | 'pair-stable' | 'pair-stable-degen' | 'pair-and-caller' | 'pair-address-stable';
    /**
     * Function name for the per-pair fee lookup. Signature is inferred from feeTarget:
     *   feeTarget="factory": (address pair) view returns (uint256)
     *   feeTarget="pair":    () view returns (uint256)
     * Defaults per group:
     *   v2fee   → "pairFee"     (Shadow-compatible; DXSwap must override to "swapFee")
     *   solidly → "getRealFee"  (Equalizer-compatible)
     */
    feeFunction?: string;
    /**
     * Divisor for raw fee values. Defaults per group:
     *   v2fee   → 1_000_000    (Shadow uses ppm)
     *   solidly → 1e18         (Equalizer uses wad)
     * DXSwap on Gnosis uses 10_000 (basis points) and must override.
     */
    feeDivisor?: number;
    /**
     * For v2fee only: does the pair contract have a `stable()` view that
     * distinguishes stable vs volatile curves? Shadow does; DXSwap doesn't.
     * When true, we batch-call pair.stable() at metadata time.
     * The solidly group always has stable from the event so this is ignored there.
     */
    hasStableFlag?: boolean;
    /**
     * Name of that bool view when it is not `stable()`. Camelot V2 pairs call it
     * `stableSwap()`; their stable pairs use the x^3y+y^3x curve and must be
     * excluded from constant-product pricing just like Solidly stable pools.
     */
    stableFunction?: string;
};

// ---- flash-loan sources ---------------------------------------------------------

export type FlashProvider = 'aave-v3' | 'balancer-v2' | 'uniswap-v3' | 'morpho';

/** FlashArbExecutor's SOURCE_* constants — the `source` argument of executeArbFrom. */
export const FLASH_SOURCES: Record<FlashProvider, number> = {
    'aave-v3': 0,
    'balancer-v2': 1,
    'uniswap-v3': 2,
    'morpho': 3,
};

/** Balancer V2's Vault lives at the same address on every chain it is deployed to. */
export const BALANCER_V2_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

export type FlashToken = {
    symbol: string;
    address: string;
    decimals: number;
    /** Override the chain-level provider for this token. */
    provider?: FlashProvider;
    /**
     * Override the lender contract for this token. REQUIRED for uniswap-v3:
     * the V3 pool to flash() from — one holding this token, deep enough, and
     * never one the cycle trades through (it is locked during the loan).
     */
    lender?: string;
    /** Override the fee for this token (for uniswap-v3: the pool's fee tier, e.g. 0.0005). */
    premium?: number;
};

export type FlashTerms = { provider: FlashProvider; source: number; lender: string; premium: number };

/**
 * How to borrow `token`: which executor source, from which contract, at what
 * fee. Token-level fields win over chain-level ones. Returns null when the
 * token is not a configured flash token or no lender can be resolved — the
 * caller must then not attempt the trade.
 *
 *   aave-v3      lender = token.lender ?? flashloan.pool
 *   balancer-v2  lender = token.lender ?? flashloan.vault ?? BALANCER_V2_VAULT
 *   morpho       lender = token.lender ?? flashloan.morpho
 *   uniswap-v3   lender = token.lender (a pool; no chain-wide default exists)
 */
export function flashTermsFor(cfg: { flashloan?: RawChainConfig['flashloan'] }, token: string): FlashTerms | null {
    const fl = cfg.flashloan;
    if (!fl) return null;
    const t = fl.tokens.find(x => x.address.toLowerCase() === token.toLowerCase());
    if (!t) return null;
    const provider = t.provider ?? fl.provider;
    const lender = t.lender ?? (
        provider === 'aave-v3'     ? fl.pool :
        provider === 'balancer-v2' ? (fl.vault ?? BALANCER_V2_VAULT) :
        provider === 'morpho'      ? fl.morpho :
        undefined);
    if (!lender || !(provider in FLASH_SOURCES)) return null;
    // A V3 pool's fee is its own tier; a chain-wide number cannot be right for
    // it, and guessing low would overstate every candidate's profit.
    if (provider === 'uniswap-v3' && t.premium == null) return null;
    const premium = t.premium ?? (provider === fl.provider ? fl.premium : (provider === 'aave-v3' ? 0.0005 : 0));
    return { provider, source: FLASH_SOURCES[provider], lender, premium };
}

export type RawChainConfig = {
    chain: ChainMeta;
    factories: {
        v2?: FactoryGroup;
        v3?: FactoryGroup;
        algebra?: FactoryGroup;
        v2fee?: FactoryGroup;    // V2 event, per-pair fee (Shadow, DXSwap)
        solidly?: FactoryGroup;  // Solidly event with stable flag, per-pair fee (Equalizer)
    };
    /**
     * Where flash loans come from. FlashArbExecutor can borrow from any of
     * four lenders (see FLASH_SOURCES); this picks the default for the chain,
     * and each token may override it — e.g. borrow WETH from a free Balancer
     * vault and USDC from Aave. See flashTermsFor() for the resolution rules.
     */
    flashloan?: {
        provider: FlashProvider;
        /** Aave V3 Pool contract (NOT the addresses provider) — flashLoanSimple lives here. Required for aave-v3. */
        pool?: string;
        addressesProvider?: string;
        /** Balancer V2 Vault. Defaults to the canonical 0xBA12…2C8 when provider is balancer-v2. */
        vault?: string;
        /** Morpho Blue singleton. Required for provider morpho (address differs per chain). */
        morpho?: string;
        /** Fee as a fraction of the amount borrowed (0.0005 = 0.05%). Default for every token. */
        premium: number;
        tokens: FlashToken[];
    };
    /**
     * Chain-tuned evaluator thresholds (piece 5), denominated in the CHAIN's
     * numeraire token (chain.token — e.g. WXDAI on Gnosis, wS on Sonic, WETH
     * on Base), NOT a flat fraction applied identically to every root token.
     * "0.10" means "0.10 WXDAI worth" — the evaluator converts that target
     * into each root token's own units using the best-liquidity direct DEX
     * pair between that root and the numeraire (reserve ratio = exchange
     * rate, no price oracle needed). A root with no direct numeraire pair
     * falls back to being treated as a flat fraction of itself, logged so
     * the gap is visible.
     *
     * These are DEFAULTS — CLI flags (--min-profit-tokens etc.) still
     * override per-run. Pick a number that's a meaningful minimum
     * profit/liquidity in the chain's numeraire, e.g. Sonic ~1 wS, Gnosis
     * ~0.10 WXDAI, Base ~0.001 WETH.
     */
    evaluator?: {
        minProfitTokens?: number;
        minLiquidityTokens?: number;
        minInputTokens?: number;
    };
    /**
     * Chain-tuned reserves-stage dust threshold (piece 4), same numeraire
     * semantics as `evaluator` above — denominated in cfg.chain.token, not a
     * flat amount applied identically to every pair-side token. Converted
     * per-token via the best-liquidity direct DB-known pair against the
     * numeraire. Falls back to a flat threshold for a token with no price
     * path yet (common on a chain's very first `yarn reserves` run, before
     * the numeraire's own pairs have reserves in the DB), logged once per
     * affected token.
     */
    reserves?: {
        dust?: number;
        /**
         * Pairs per YoBatches eth_call. Default 200 (RESERVES_BATCH_SIZE).
         *
         * This is the main lever on reserves wall time, because the run is
         * round-trip bound rather than compute bound: Polygon's 203,832 pairs
         * took 407s, 94% of it in three factories whose 20-way concurrency
         * yielded only 1.8x the throughput of the serial small ones.
         *
         * Measured on anvil with every account access cold, YoBatches costs
         * ~16.6k gas/pair, so 200 pairs is ~3.3M gas — roughly 7% of a typical
         * 50M eth_call cap. There is a lot of headroom, but the biggest batch
         * that WORKS is not always the fastest: latency and response size both
         * grow with it, and public endpoints rate-limit on requests, bytes or
         * compute depending on the vendor. Measure before changing:
         *   node --experimental-strip-types scripts/probe-batch-size.mjs <chain>
         */
        batchSize?: number;
        /**
         * Concentrated-liquidity pools per YoBatches2.getV3State call.
         * Default 100. Measured cold on anvil: ~150k gas/pool at v3Words=2,
         * so 100 pools is ~15M gas — well inside a 50M eth_call cap, with
         * room for pools with far more initialized ticks than the test had.
         */
        v3BatchSize?: number;
        /**
         * Tick window half-width, in tickBitmap words (256 tick spacings
         * each), fetched around every v3 pool's current tick. Default 2.
         * A swap that walks past the window is scored only up to its edge
         * (conservative), so too small costs opportunity, not correctness.
         */
        v3Words?: number;
        /**
         * Reachability prefilter for concentrated-liquidity pools. Default on.
         *
         * A triangle starts and ends at a root token (flashloan.tokens, plus
         * chain.token), so a pool can only ever be used if it is either
         *   - a ROOT pool (one side is a root) whose root-side BALANCE is at
         *     least v3MinRootBalance (in that root's own units), or
         *   - a pool between two tokens that each have such a root pool.
         * Everything else is unreachable by the enumerator whatever its state
         * is, so getV3State — the expensive read — is skipped for it and it
         * is stored with zero reserves. The root balances come from one cheap
         * getReserves pass (two balanceOf per root pool, v2 and v3 alike).
         *
         * A pool's real balance is an upper bound on what a swap can take out
         * of it, so the balance test never drops a pool that could pay out
         * v3MinRootBalance of the root.
         */
        v3Prefilter?: boolean;
        /**
         * Apply the same reachability test to V2-style pairs. Default on.
         * Root pairs below the threshold, and pairs between two tokens with
         * no qualifying root pair, are not read and get zero reserves. On
         * Base that is most of Uniswap V2's ~3M pairs — memecoin pairs whose
         * root side is dust. Factory DEAD/THIN stats then cover only the
         * pairs that were read.
         */
        v2Prefilter?: boolean;
        /** Alias of v3MinRootBalance; it now governs both prefilters. */
        minRootBalance?: number;
        /**
         * Minimum root-side balance for a root pool to count as reachable, in
         * the root token's own units (like evaluator.minLiquidityTokens).
         * Default: evaluator.minLiquidityTokens, else 0 (only empty pools drop).
         */
        v3MinRootBalance?: number;
        /**
         * How long the prefilter's root-pool balance reads are reused, in
         * hours. Default 12; 0 = re-read every run. Those reads are most of
         * the prefilter's cost on a chain with millions of dead pools (Base:
         * 4.7M root pools, ~1.5 GB of JSON-RPC traffic), and a pool that held
         * no root this morning almost certainly holds none tonight.
         */
        v3PrefilterTtlHours?: number;
    };
};

// -----------------------------------------------------------------------------
// Normalized types for consumers

export type NormalizedFactory = {
    group: 'v2' | 'v3' | 'algebra' | 'v2fee' | 'solidly';
    name: string;
    address: string;
    deployBlock: number;
    /**
     * Flat fee (used directly, no metadata multicall).
     * - v2: always populated (default 0.003 for canonical Uniswap V2).
     * - v3/algebra: undefined — fees are per pool (pairs.fee, pool.fee()).
     * - v2fee/solidly: optional. When set, opts into flat-fee mode. When
     *   undefined, per-pair fee is fetched via feeTarget/feeFunction/feeDivisor.
     */
    fee: number | undefined;

    /**
     * Static per-pair-type fees for factories whose fees are hardcoded in
     * swap() based on pair.stable. Overrides `fee`; ignored if `feeFunction`
     * is set. When present, metadata step does a bulk UPDATE with the
     * appropriate fee per pair based on the pair's cached stable flag.
     */
    stableFees: { stable: number; volatile: number } | undefined;
    /** For v2fee/solidly: "factory" or "pair" — where to call the fee function. */
    feeTarget: 'factory' | 'pair';
    feeArgSource: 'pair-address' | 'pair-stable' | 'pair-stable-degen' | 'pair-and-caller' | 'pair-address-stable';
    /** For v2fee/solidly: factory function returning per-pair fee. Default per group. */
    feeFunction: string;
    /** For v2fee/solidly: divisor for raw fee values. Default per group. */
    feeDivisor: number;
    /** For v2fee only: does the pair have a stable() view? Default false. */
    hasStableFlag: boolean;
    /** The pair's stable-curve bool view, when hasStableFlag. Default "stable". */
    stableFunction: string;
    /** v3 group: creation event shape, default "uniswap". solidly group: "velodrome" or undefined (classic). */
    poolEvent: 'uniswap' | 'tickspacing' | 'velodrome' | undefined;
    /** v3 group only: measured swap-callback name, if configured. */
    callback: string | undefined;
    abi: string[];
};

export type ChainConfig = {
    raw: RawChainConfig;
    chain: ChainMeta;
    factories: NormalizedFactory[];
    flashloan?: RawChainConfig['flashloan'];
    evaluator?: RawChainConfig['evaluator'];
    reserves?: RawChainConfig['reserves'];
    scan: ScanTuning;
};

/**
 * Runtime knobs for the scanner. Resolved from (in precedence order):
 *   1. `${CHAIN}_SCAN_*` env vars (per-chain override)
 *   2. `SCAN_*` env vars (all chains)
 *   3. `chain.pagesize` in the JSON5 config (legacy field, only for chunkStart)
 *   4. Defaults
 */
export type ScanTuning = {
    /** Blocks per eth_getLogs — initial value, adaptive */
    chunkStart: number;
    /** Minimum chunk size before we give up */
    chunkMin: number;
    /** Cap on how large the chunk can grow after successful calls */
    chunkMax: number;
    /** Delay between successful chunks, to be nice to rate-limited RPCs (ms) */
    chunkDelayMs: number;
    /**
     * A factory whose saved progress is at most this many blocks behind the
     * head is caught up INCREMENTALLY: all such factories share one
     * eth_getLogs per chunk over the chain's own RPC (websocket first), with
     * no HyperSync request at all. Further behind (or never scanned), it gets
     * the per-factory HyperSync scan. Default 40 x chunkStart — at most ~40
     * getLogs calls for the whole catch-up. `${CHAIN}_SCAN_INCREMENTAL_BLOCKS`
     * / `SCAN_INCREMENTAL_BLOCKS`; 0 turns incremental mode off.
     */
    incrementalMaxBlocks: number;
};

function resolveScanTuning(chainLabel: string, raw: RawChainConfig): ScanTuning {
    const upper = chainLabel.toUpperCase().replace(/-/g, '_');
    const num = (v: string | undefined, dflt: number): number => {
        if (v === undefined || v === '') return dflt;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : dflt;
    };
    const chunkStart = num(process.env[`${upper}_SCAN_CHUNK_START`] ?? process.env.SCAN_CHUNK_START,
                           raw.chain.pagesize && raw.chain.pagesize < 100000 ? raw.chain.pagesize : 5000);
    const incr = process.env[`${upper}_SCAN_INCREMENTAL_BLOCKS`] ?? process.env.SCAN_INCREMENTAL_BLOCKS;
    return {
        chunkStart,
        chunkMin:     num(process.env[`${upper}_SCAN_CHUNK_MIN`]   ?? process.env.SCAN_CHUNK_MIN,   10),
        chunkMax:     num(process.env[`${upper}_SCAN_CHUNK_MAX`]   ?? process.env.SCAN_CHUNK_MAX,   50000),
        chunkDelayMs: num(process.env[`${upper}_SCAN_DELAY_MS`]    ?? process.env.SCAN_DELAY_MS,    0),
        // `num` rejects 0, and 0 is meaningful here (off), so parse directly.
        incrementalMaxBlocks: incr !== undefined && incr !== '' && Number.isFinite(Number(incr)) && Number(incr) >= 0
            ? Number(incr) : chunkStart * 40,
    };
}

// -----------------------------------------------------------------------------

/**
 * Load the shared chain metadata registry (@chains.json5). The registry is
 * keyed by label (the CLI slug), with `name` stored in each entry as the
 * display name shown in logs. Every entry is normalized so the ChainMeta
 * always has both `label` (the object key) and `name`.
 */
export function loadChainRegistry(): Record<string, ChainMeta> {
    const p = path.join(CONF_DIR, '@chains.json5');
    const raw = JSON5.parse(fs.readFileSync(p, 'utf-8')) as Record<string, Partial<ChainMeta>>;
    const byLabel: Record<string, ChainMeta> = {};
    for (const [label, entry] of Object.entries(raw)) {
        if (entry.id == null)   throw new Error(`Chain "${label}" in @chains.json5 is missing "id"`);
        if (!entry.name)        throw new Error(`Chain "${label}" in @chains.json5 is missing "name"`);
        if (!entry.host)        throw new Error(`Chain "${label}" in @chains.json5 is missing "host"`);
        const meta: ChainMeta = {
            id:            entry.id,
            name:          entry.name,
            label,
            currency:      entry.currency ?? '',
            token:         entry.token,
            host:          entry.host,
            hypersyncUrl:  entry.hypersyncUrl,
            // `wss` accepted as an alias: it is the natural thing to type for a
            // wss:// URL, and a silently ignored key means silent HTTP polling.
            ws:            entry.ws ?? (entry as any).wss,
            explorer:      entry.explorer,
            contract:      entry.contract,
            threads:       entry.threads,
            interval:      entry.interval,
            pagesize:      entry.pagesize,
            alchemy:       entry.alchemy,
        };
        byLabel[label] = meta;
    }
    return byLabel;
}

/**
 * Resolve a user-provided chain argument to its normalized ChainMeta. Matches
 * against label first (case-insensitive), then falls back to display name.
 *
 *   resolveChain("sonic")           → Sonic
 *   resolveChain("Sonic")           → Sonic  (via name)
 *   resolveChain("bsc")             → BNB Smart Chain
 *   resolveChain("BNB Smart Chain") → BNB Smart Chain
 */
export function resolveChain(arg: string): ChainMeta {
    const registry = loadChainRegistry();
    const lower = arg.toLowerCase();

    // Try label first (fast path — this is what CLI args match)
    if (registry[lower]) return registry[lower];

    // Fall back to display name match
    for (const meta of Object.values(registry)) {
        if (meta.name.toLowerCase() === lower) return meta;
    }

    const known = Object.values(registry).map(m => `${m.label} (${m.name})`).join(', ');
    throw new Error(`Unknown chain "${arg}". Known: ${known}`);
}

/**
 * Load a per-chain config file, keyed by label. Merges with the ChainMeta
 * from the registry (so per-chain files can override registry defaults).
 */
export function loadChainConfig(chainArg: string): ChainConfig {
    const meta = resolveChain(chainArg);
    const p = path.join(CONF_DIR, `${meta.label}.json5`);
    if (!fs.existsSync(p)) {
        throw new Error(`No config file for chain "${meta.name}" at ${p} (label: "${meta.label}")`);
    }
    const raw = JSON5.parse(fs.readFileSync(p, 'utf-8')) as RawChainConfig;

    // Merge registry defaults with per-chain overrides. Per-chain wins for
    // fields both specify. But name/label always come from the registry (they're
    // the identity of the chain, not a per-file concern).
    raw.chain = {
        ...meta,
        ...raw.chain,
        name:  meta.name,
        label: meta.label,
    };

    // Env override for RPC (uses the label uppercased)
    const envKey = `${meta.label.toUpperCase().replace(/-/g, '_')}_RPC`;
    if (process.env[envKey]) {
        raw.chain.host = process.env[envKey]!;
    }
    // Same alias in the per-chain file's chain block.
    if (!raw.chain.ws && (raw.chain as any).wss) raw.chain.ws = (raw.chain as any).wss;
    const wsKey = `${meta.label.toUpperCase().replace(/-/g, '_')}_WS`;
    if (process.env[wsKey]) {
        raw.chain.ws = process.env[wsKey]!;
    }

    // Flatten the factory groups
    const factories: NormalizedFactory[] = [];
    const KNOWN_GROUPS = ['v2', 'v3', 'algebra', 'v2fee', 'solidly'] as const;
    const knownSet = new Set<string>(KNOWN_GROUPS);

    // Warn about unknown top-level keys under "factories" — common source of
    // silent data loss when someone misspells a group name. We only iterate
    // the known set, so anything else is silently dropped unless we shout.
    if (raw.factories) {
        for (const key of Object.keys(raw.factories)) {
            if (!knownSet.has(key)) {
                console.warn(
                    `[config] WARNING: unknown factory group "${key}" in ${meta.label}.json5. ` +
                    `Its factories will NOT be scanned. Known groups: ${KNOWN_GROUPS.join(', ')}. ` +
                    `Common mistakes: "solidity-*"/"solidly-*"/"solidly-v2" — the group is now "solidly" or "v2fee".`
                );
            }
        }
    }

    for (const group of KNOWN_GROUPS) {
        const g = raw.factories?.[group];
        if (!g) continue;

        // Per-group defaults. Overrides land in FactoryEntry fields.
        //   v2fee:   Shadow's convention (pairFee on factory, 1e6 ppm).
        //            DXSwap uses "swapFee" on pair with 10_000 — needs full override.
        //   solidly: Equalizer's convention (getRealFee on factory, 1e18 wad).
        const defaultFeeFunction =
            group === 'v2fee'   ? 'pairFee' :
            group === 'solidly' ? 'getRealFee' :
            'pairFee';  // unused for pure v2/v3/algebra but the type demands a string
        const defaultFeeDivisor =
            group === 'v2fee'   ? 1_000_000 :
            group === 'solidly' ? 1e18 :
            10_000;

        for (const [name, entry] of Object.entries(g.list)) {
            const isString = typeof entry === 'string';
            // Fee defaulting rules:
            //   v2       → fee is authoritative; default 0.003 (canonical Uniswap V2)
            //   v2fee    → fee is OPTIONAL and opt-in for flat-fee mode; leave undefined
            //             otherwise so the metadata multicall runs per-pair.
            //   solidly  → same as v2fee — fee is opt-in for flat-fee mode.
            //
            // Setting a default fee on v2fee/solidly would silently skip the
            // per-pair metadata fetch (flat-fee fast path fires when factory.fee
            // is defined), which is a subtle bug that produces mostly-correct
            // math but hides real per-pair fee variance.
            // v3/algebra: NO factory-wide fee. Every pool has its own (fee
            // tiers, per-pool dynamic fees); it is read from the PoolCreated
            // event at scan time and from pool.fee() at reserves time. A
            // 0.003 default here would silently misprice every 0.05% and 1%
            // pool that had not been read yet.
            const defaultFee = group === 'v2' ? 0.003 : undefined;

            // Pattern registry auto-populate: extract the base pattern name from
            // the config key by stripping the `_[a-f0-9]{8}` address suffix,
            // then look up the registered pattern. Its values fill in as
            // DEFAULTS for anything the config didn't explicitly set. Lets
            // users add `WhaleswapFactory_abc26f83: { address: "..." }` and
            // get the right fee mode automatically — no need to paste the
            // full fee metadata block.
            //
            // Explicit entry fields always win; the pattern only fills gaps.
            const patternKey = name.replace(/_[a-fA-F0-9]{8}$/, '');
            // Only when the pattern is for THIS group: a generic contract name
            // ("PoolFactory") can belong to an unrelated DEX in another group
            // — monad's v2 PoolFactory_fadee2fb is a plain V2 factory and must
            // not inherit Velodrome's fee lookup.
            const patternHit = !isString ? lookupDexPattern(patternKey) : null;
            const pattern = patternHit && patternHit.family === group ? patternHit : null;

            factories.push({
                group,
                name,
                address: isString ? entry : entry.address,
                deployBlock: isString ? 0 : (entry.deployBlock ?? 0),
                fee: isString ? defaultFee : (entry.fee ?? pattern?.fee ?? defaultFee),
                stableFees: isString ? undefined : (entry.stableFees ?? pattern?.stableFees),
                feeTarget:     isString ? 'factory'      : (entry.feeTarget     ?? pattern?.feeTarget     ?? 'factory'),
                feeArgSource:  isString ? 'pair-address' : (entry.feeArgSource  ?? pattern?.feeArgSource  ?? 'pair-address'),
                feeFunction:   isString ? defaultFeeFunction : (entry.feeFunction ?? pattern?.feeFunction ?? defaultFeeFunction),
                feeDivisor:    isString ? defaultFeeDivisor  : (entry.feeDivisor  ?? pattern?.feeDivisor  ?? defaultFeeDivisor),
                hasStableFlag: isString ? false : (entry.hasStableFlag ?? pattern?.hasStableFlag ?? false),
                stableFunction: (isString ? undefined : entry.stableFunction) ?? 'stable',
                poolEvent: group === 'v3'
                    ? (isString ? 'uniswap' : ((entry.poolEvent as 'uniswap' | 'tickspacing' | undefined) ?? 'uniswap'))
                    : group === 'solidly'
                        // Explicit only. The pattern knows "PoolFactory" contracts
                        // usually emit the Velodrome event, but a contract NAME does
                        // not prove which event a factory emits, and the wrong one
                        // scans zero pairs. find-factories writes it from the sweep.
                        ? (isString ? undefined : entry.poolEvent) === 'velodrome' ? 'velodrome' : undefined
                        : undefined,
                callback:  isString ? undefined : entry.callback,
                abi: g.abi,
            });
        }
    }

    // Apply blacklist — remove factories flagged as dead/scam in
    // conf/<chain>-blacklist.json5. Filtering here (in loadChainConfig)
    // ensures every downstream stage (scanner, reserves, triangles, evaluator)
    // sees the same filtered list. Zero-cost when no blacklist file exists.
    const blacklist = blacklistedAddresses(meta.label);
    const filteredCount = factories.length;
    const filteredFactories = factories.filter(f => !blacklist.has(f.address.toLowerCase()));
    const excluded = filteredCount - filteredFactories.length;
/*    if (excluded > 0) {
        console.log(`[blacklist] Excluded ${excluded} factory(ies) via conf/${meta.label}-blacklist.json5`);
    }*/

    return {
        raw,
        chain: raw.chain,
        factories: filteredFactories,
        flashloan: raw.flashloan,
        evaluator: raw.evaluator,
        reserves: raw.reserves,
        scan: resolveScanTuning(meta.label, raw),
    };
}

/**
 * Absolute path to the SQLite database for a chain. Resolves the arg to a
 * chain label so `dbPath("Sonic")` and `dbPath("sonic")` both go to
 * `db/sonic.sqlite`.
 */
export function dbPath(chainArg: string): string {
    const meta = resolveChain(chainArg);
    const dir = path.join(PROJECT_ROOT, 'db');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${meta.label}.sqlite`);
}

/**
 * Absolute path to the cross-chain trade ledger (source/util/ledger.ts).
 * Deliberately NOT chain-specific — one ledger spans every chain the bot
 * trades on, unlike dbPath()'s per-chain scan/reserves/triangles caches.
 */
export function ledgerPath(): string {
    // ARB_LEDGER: tests point this at a scratch file, so running them can never
    // touch (or, in test-hot's case, delete) the real trade ledger.
    if (process.env.ARB_LEDGER) return process.env.ARB_LEDGER;
    const dir = path.join(PROJECT_ROOT, 'db');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'ledger.sqlite');
}
