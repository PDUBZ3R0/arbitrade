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
    hypersyncUrl?: string;     // Envio HyperSync URL (e.g. "https://sonic.hypersync.xyz")
    contract?: string;         // deployed YoBatches address
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
    feeArgSource?: 'pair-address' | 'pair-stable' | 'pair-stable-degen' | 'pair-and-caller';
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
};

export type RawChainConfig = {
    chain: ChainMeta;
    factories: {
        v2?: FactoryGroup;
        v3?: FactoryGroup;
        algebra?: FactoryGroup;
        v2fee?: FactoryGroup;    // V2 event, per-pair fee (Shadow, DXSwap)
        solidly?: FactoryGroup;  // Solidly event with stable flag, per-pair fee (Equalizer)
    };
    flashloan?: {
        provider: 'aave-v3' | 'balancer-v2';
        addressesProvider?: string;
        vault?: string;
        premium: number;
        tokens: Array<{ symbol: string; address: string; decimals: number }>;
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
     * - v2/v3: always populated (default 0.003 for canonical Uniswap V2).
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
    feeArgSource: 'pair-address' | 'pair-stable' | 'pair-stable-degen' | 'pair-and-caller';
    /** For v2fee/solidly: factory function returning per-pair fee. Default per group. */
    feeFunction: string;
    /** For v2fee/solidly: divisor for raw fee values. Default per group. */
    feeDivisor: number;
    /** For v2fee only: does the pair have a stable() view? Default false. */
    hasStableFlag: boolean;
    abi: string[];
};

export type ChainConfig = {
    raw: RawChainConfig;
    chain: ChainMeta;
    factories: NormalizedFactory[];
    flashloan?: RawChainConfig['flashloan'];
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
};

function resolveScanTuning(chainLabel: string, raw: RawChainConfig): ScanTuning {
    const upper = chainLabel.toUpperCase().replace(/-/g, '_');
    const num = (v: string | undefined, dflt: number): number => {
        if (v === undefined || v === '') return dflt;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : dflt;
    };
    return {
        chunkStart:   num(process.env[`${upper}_SCAN_CHUNK_START`] ?? process.env.SCAN_CHUNK_START,
                          raw.chain.pagesize && raw.chain.pagesize < 100000 ? raw.chain.pagesize : 5000),
        chunkMin:     num(process.env[`${upper}_SCAN_CHUNK_MIN`]   ?? process.env.SCAN_CHUNK_MIN,   10),
        chunkMax:     num(process.env[`${upper}_SCAN_CHUNK_MAX`]   ?? process.env.SCAN_CHUNK_MAX,   50000),
        chunkDelayMs: num(process.env[`${upper}_SCAN_DELAY_MS`]    ?? process.env.SCAN_DELAY_MS,    0),
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
            const defaultFee = group === 'v2' || group === 'v3' || group === 'algebra' ? 0.003 : undefined;

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
            const pattern = !isString ? lookupDexPattern(patternKey) : null;

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
