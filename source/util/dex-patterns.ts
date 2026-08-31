// -----------------------------------------------------------------------------
// Known DEX pattern registry.
//
// Maps canonical Solidity contract names (as they appear on Etherscan's
// verified-source view) to their known fee model configuration. Used by
// find-factories to emit config snippets pre-populated with the right
// feeTarget/feeFunction/feeDivisor for factories whose source came from a
// well-known template.
//
// This is the "we know what this is" table. When a factory's contract
// name is a hit here, we don't have to guess at fees — we know the DEX
// family and its fee-lookup convention from the source template.
//
// Why this matters:
//   - `UniswapV2FactoryCustomFee`-derived contracts are extremely common.
//     Any factory whose source came from that template has the same fee
//     API (feeTarget=pair, feeFunction=fee, feeDivisor=1000). We should
//     auto-populate those defaults, not make the user paste them.
//   - The registry is data, not code. New patterns can be added by editing
//     this file, no classifier changes required.
//
// How to add a pattern:
//   1. Look up the contract's verified source on the block explorer
//   2. Find the fee-lookup function and its scale factor
//   3. Add an entry keyed by the exact contract name (case-insensitive match
//      at lookup time)
//   4. Include a `notes` string with a URL to the source so the next person
//      can verify
// -----------------------------------------------------------------------------

export type DexPattern = {
    /**
     * Factory family. Overrides verify-factory's runtime guess. This lets the
     * pattern say "these are actually v2fee even if the runtime probes couldn't
     * derive it" (e.g. when the RPC blocked eth_call temporarily).
     */
    family: 'v2' | 'v2fee' | 'solidly';

    /**
     * Where the fee is stored:
     *   'factory' — call `factory.<feeFunction>(...)` returning the fee
     *   'pair'    — call `pair.<feeFunction>()` returning the fee
     */
    feeTarget?: 'factory' | 'pair';

    /**
     * For feeTarget='factory' only: what to pass as the function argument.
     *   'pair-address' (default) — factory.<fn>(pair)
     *   'pair-stable'            — factory.<fn>(pair.stable) — PairFactoryUpgradeable
     */
    feeArgSource?: 'pair-address' | 'pair-stable';

    /** Function name to call for the fee lookup. */
    feeFunction?: string;

    /**
     * Scale factor for the returned fee. Convert to decimal: raw / feeDivisor.
     * Common values:
     *   1000       — fee returned in 0.1% units (raw=3 means 0.3%)
     *   10000      — basis points (raw=30 means 0.3%)
     *   1_000_000  — millionths (Shadow-style raw=3000 means 0.3%)
     *   1e18       — wad (Equalizer-style raw=3e15 means 0.3%)
     */
    feeDivisor?: number;

    /**
     * Optional flat-fee override. When set, skip metadata multicall entirely
     * and apply this fee to every pair from this factory. Use for factories
     * with a uniform fee (Dystopia 0.05%, PancakeSwap 0.25%) or where the
     * fee is hardcoded in swap() and not queryable.
     */
    fee?: number;

    /**
     * Whether the pair contract exposes `stable()` (Shadow-family v2fee). Set
     * true for v2fee factories whose pairs distinguish stable-swap curve
     * from volatile — this affects swap math even without a Solidly event.
     */
    hasStableFlag?: boolean;

    /**
     * Human notes: the DEX brand name, doc URL, verified example address,
     * or anything else that helps the next person confirm the pattern is
     * still current.
     */
    notes?: string;
};

/**
 * Registry keyed by contract name as it appears on block explorers.
 * Lookup is case-insensitive.
 */
export const DEX_PATTERNS: Record<string, DexPattern> = {

    // ORDER MATTERS — patterns are probed in this order. Put the more
    // distinctive / higher-priority patterns first so that when several
    // could plausibly match, the first hit wins.

    // --- Solidly family (Solidly-event PairCreated) ----------------------

    'EqualizerFactory': {
        // Equalizer on Sonic; wad-scaled per-pair fee.
        family:      'solidly',
        feeTarget:   'factory',
        feeFunction: 'getRealFee',
        feeDivisor:  1e18,
        notes:       'Equalizer (Sonic) — factory.getRealFee(pair) returns wad-scaled fee (raw / 1e18).',
    },

    'BaseV1Factory': {
        // Retro / BaseV1Factory family. pair.swapFee() / 1e6.
        // Default values: stable normal=100 (0.01%), volatile normal=2000 (0.20%),
        // stable priority=50 (0.005%), volatile priority=1000 (0.10%).
        family:      'solidly',
        feeTarget:   'pair',
        feeFunction: 'swapFee',
        feeDivisor:  1_000_000,
        notes:       'Retro / BaseV1Factory — pair.swapFee() / 1e6. Priority pairs can be overridden per-pair.',
    },

    'PairFactoryUpgradeable': {
        // factory.getFee(bool stable) returns defaults for new pairs. If the
        // pair contract also exposes swapFee (BaseV1-family), prefer that.
        family:       'solidly',
        feeTarget:    'factory',
        feeArgSource: 'pair-stable',
        feeFunction:  'getFee',
        feeDivisor:   10000,
        notes:        'Velodrome V1-family (PairFactoryUpgradeable) — factory.getFee(bool). See BaseV1Factory for per-pair reading when both apply.',
    },

    'DystFactory': {
        family: 'solidly',
        fee:    0.0005,
        notes:  'Dystopia — flat 0.05% fee for all pairs.',
    },

    // --- V2fee family (V2-event PairCreated + per-pair fees) -------------

    'ShadowV3Factory': {
        family:        'v2fee',
        feeTarget:     'factory',
        feeFunction:   'pairFee',
        feeDivisor:    1_000_000,
        hasStableFlag: true,
        notes:         'Shadow (Sonic) — factory.pairFee(pair) / 1e6. Pairs expose stable() bool.',
    },

    'DXswapFactory': {
        family:      'v2fee',
        feeTarget:   'pair',
        feeFunction: 'swapFee',
        feeDivisor:  10000,
        notes:       'DXswap (Swapr) — pair.swapFee() returns basis points.',
    },

    'UniswapV2FactoryCustomFee': {
        family:      'v2fee',
        feeTarget:   'pair',
        feeFunction: 'fee',
        feeDivisor:  1000,
        notes:       'Widely-forked template — pair exposes uint16 `fee` in 0.1% units.',
    },
};

/**
 * Look up a DEX pattern by contract name (case-insensitive). Returns null if
 * no known pattern matches — caller should fall back to runtime-detected
 * family + default fee shape.
 */
export function lookupDexPattern(contractName: string | undefined): DexPattern | null {
    if (!contractName) return null;
    const target = contractName.toLowerCase();
    for (const [key, pattern] of Object.entries(DEX_PATTERNS)) {
        if (key.toLowerCase() === target) return pattern;
    }
    return null;
}

/**
 * Render a JSON5-ish config snippet body for a known pattern. Used by
 * find-factories when a candidate's contract name matches a registered
 * pattern. Callers wrap this in the appropriate `factories[<group>].list`
 * container.
 *
 * Emits only the fields that differ from defaults, so config stays readable.
 */
export function renderPatternSnippet(
    address: string,
    deployBlock: number | undefined,
    pattern: DexPattern,
): string {
    const lines: string[] = [`address: "${address}"`];
    if (deployBlock) lines.push(`deployBlock: ${deployBlock}`);
    if (pattern.hasStableFlag) lines.push(`hasStableFlag: true`);
    if (pattern.fee !== undefined) {
        lines.push(`fee: ${pattern.fee}   // flat-fee mode, no per-pair multicall`);
    } else {
        // Per-pair mode — emit the trio (plus feeArgSource if non-default)
        if (pattern.feeTarget)     lines.push(`feeTarget: "${pattern.feeTarget}"`);
        if (pattern.feeArgSource && pattern.feeArgSource !== 'pair-address') {
            lines.push(`feeArgSource: "${pattern.feeArgSource}"`);
        }
        if (pattern.feeFunction)   lines.push(`feeFunction: "${pattern.feeFunction}"`);
        if (pattern.feeDivisor)    lines.push(`feeDivisor: ${pattern.feeDivisor}`);
    }
    return lines.map(l => `          ${l}`).join(',\n');
}
