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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CONF_DIR = path.join(PROJECT_ROOT, 'conf');

// -----------------------------------------------------------------------------
// Types matching the on-disk shape

export type ChainMeta = {
    id: number;
    name: string;
    currency: string;
    token?: string;           // native wrapped (WETH, WMATIC, wS...)
    host: string;
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
    fee?: number;
    /**
     * For solidly-family factories where fee is per-pair (looked up via
     * factory.pairFee), this divides the raw uint returned by pairFee to
     * yield the decimal fee. Defaults to 10_000 (basis points). Shadow on
     * Sonic and similar forks use 1_000_000 (parts per million).
     */
    feeDivisor?: number;
};

export type RawChainConfig = {
    chain: ChainMeta;
    factories: {
        v2?: FactoryGroup;
        v3?: FactoryGroup;
        algebra?: FactoryGroup;
        'solidly-v2'?: FactoryGroup;      // Solidly-family emitting V2-standard PairCreated (Shadow)
        'solidly-native'?: FactoryGroup;  // Solidly emitting the extra-bool PairCreated (Aerodrome, etc.)
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
    group: 'v2' | 'v3' | 'algebra' | 'solidly-v2' | 'solidly-native';
    name: string;
    address: string;
    deployBlock: number;
    fee: number;
    /** For solidly-family: divisor for factory.pairFee(pair) raw values. Default 10_000. */
    feeDivisor: number;
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

function resolveScanTuning(chainName: string, raw: RawChainConfig): ScanTuning {
    const upper = chainName.toUpperCase();
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
 * Load the shared chain metadata registry (@chains.json5).
 */
export function loadChainRegistry(): Record<string, ChainMeta> {
    const p = path.join(CONF_DIR, '@chains.json5');
    return JSON5.parse(fs.readFileSync(p, 'utf-8'));
}

/**
 * Load a per-chain config file (polygon.json5, sonic.json5, ...) and return it
 * with the factory tree flattened into a NormalizedFactory[] for iteration.
 */
export function loadChainConfig(chainName: string): ChainConfig {
    const p = path.join(CONF_DIR, `${chainName.toLowerCase()}.json5`);
    if (!fs.existsSync(p)) {
        throw new Error(`No config file for chain "${chainName}" at ${p}`);
    }
    const raw = JSON5.parse(fs.readFileSync(p, 'utf-8')) as RawChainConfig;

    // Env overrides for the RPC
    const envKey = `${chainName.toUpperCase()}_RPC`;
    if (process.env[envKey]) {
        raw.chain.host = process.env[envKey]!;
    }

    // Flatten the factory groups
    const factories: NormalizedFactory[] = [];
    const KNOWN_GROUPS = ['v2', 'v3', 'algebra', 'solidly-v2', 'solidly-native'] as const;
    const knownSet = new Set<string>(KNOWN_GROUPS);

    // Warn about unknown top-level keys under "factories" — common source of
    // silent data loss when someone misspells a group name (e.g. "solidity"
    // instead of "solidly"). We only iterate the known set, so anything else
    // is silently dropped unless we shout about it.
    if (raw.factories) {
        for (const key of Object.keys(raw.factories)) {
            if (!knownSet.has(key)) {
                console.warn(
                    `[config] WARNING: unknown factory group "${key}" in ${chainName}.json5. ` +
                    `Its factories will NOT be scanned. Known groups: ${KNOWN_GROUPS.join(', ')}. ` +
                    `Common typo: "solidity-*" should be "solidly-*".`
                );
            }
        }
    }

    for (const group of KNOWN_GROUPS) {
        const g = raw.factories?.[group];
        if (!g) continue;
        for (const [name, entry] of Object.entries(g.list)) {
            const isString = typeof entry === 'string';
            factories.push({
                group,
                name,
                address: isString ? entry : entry.address,
                deployBlock: isString ? 0 : (entry.deployBlock ?? 0),
                fee: isString ? 0.003 : (entry.fee ?? 0.003),
                feeDivisor: isString ? 10_000 : (entry.feeDivisor ?? 10_000),
                abi: g.abi,
            });
        }
    }

    return {
        raw,
        chain: raw.chain,
        factories,
        flashloan: raw.flashloan,
        scan: resolveScanTuning(chainName, raw),
    };
}

/**
 * Absolute path to the SQLite database for a chain.
 */
export function dbPath(chainName: string): string {
    const dir = path.join(PROJECT_ROOT, 'db');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${chainName.toLowerCase()}.sqlite`);
}
