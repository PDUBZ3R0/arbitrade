// -----------------------------------------------------------------------------
// Interface probing.
//
// When we can't identify a factory by its Etherscan contract name (either
// because the contract is unverified, or its name is generic like
// "TransparentUpgradeableProxy"), we probe the factory + a sample pair against
// every known pattern in DEX_PATTERNS. First pattern that returns a plausible
// fee value wins.
//
// Plausibility filter: adjusted fee (raw / divisor) must land in
// [0.00005, 0.05] — i.e., 0.005% to 5%. This range covers everything from
// Retro priority-stable pools (0.005%) to the highest fee tiers seen on real
// DEXes (a few percent). Values outside this range indicate wrong divisor,
// wrong function, or a garbage return.
//
// Multiple patterns can plausibly match — e.g. both DXSwap (pair.swapFee()/1e4)
// and BaseV1 (pair.swapFee()/1e6) call the same function but with different
// divisors. Plausibility naturally disambiguates: raw=30 → DXSwap says 0.003
// (valid), BaseV1 says 0.00003 (below range) → DXSwap wins. Raw=2000 → DXSwap
// says 0.2 (above range), BaseV1 says 0.002 (valid) → BaseV1 wins.
//
// Cross-pair consistency: for higher confidence, probe multiple sample pairs.
// A pattern that gives sensible-and-consistent values across pairs is "high"
// confidence. Single pair or wildly varying values (10x range) = "medium".
// Only-just-inside-range values = "low".
//
// Family constraint: matchedTopic from event detection filters which patterns
// to consider. Solidly event → probe only solidly patterns. V2 event → probe
// only v2fee patterns. This prevents impossible matches.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface } from 'ethers';
import { DEX_PATTERNS, type DexPattern } from './dex-patterns.ts';

// Fee plausibility range. Below is unrealistic-low; above is unrealistic-high.
const MIN_PLAUSIBLE_FEE = 0.00005;   // 0.005% — Retro priority stable
const MAX_PLAUSIBLE_FEE = 0.05;      // 5%    — extreme high-fee pools

// "Typical" fee band. Values in this band get high-confidence tag; outside
// but still within plausible get medium/low.
const TYPICAL_MIN = 0.0001;   // 0.01%
const TYPICAL_MAX = 0.01;     // 1.0%

export type SamplePair = {
    pair: string;
    stable: boolean | null;
};

export type ProbeMatch = {
    /** Registry key for the matched pattern (e.g. 'BaseV1Factory'). */
    patternName: string;
    /** The pattern's configuration — feeds directly into the config snippet. */
    pattern: DexPattern;
    /**
     * Raw fee value returned by the contract, per sample pair. Useful for
     * debug/diagnostics and cross-pair consistency scoring.
     */
    sampleFeesRaw: bigint[];
    /** Fees after divisor applied — human-readable. */
    sampleFeesAdjusted: number[];
    /** Overall confidence assessment. */
    confidence: 'high' | 'medium' | 'low';
    /** Concise reason for the confidence rating. */
    reason: string;
};

/**
 * Try one pattern against the given factory + sample pairs. Returns null if
 * the pattern doesn't match at all (all calls reverted or all values
 * out-of-range). Returns a ProbeMatch with confidence rating otherwise.
 */
async function tryPattern(
    provider: JsonRpcProvider,
    factory: string,
    samplePairs: SamplePair[],
    patternName: string,
    pattern: DexPattern,
): Promise<ProbeMatch | null> {
    // Flat-fee patterns can't be probed — they have no on-chain fee query.
    // These have to be identified by name only.
    if (pattern.fee !== undefined) return null;
    if (!pattern.feeFunction || !pattern.feeTarget || !pattern.feeDivisor) return null;

    // Build the ABI signature based on pattern's target + arg source
    let sig: string;
    if (pattern.feeTarget === 'pair') {
        sig = `function ${pattern.feeFunction}() view returns (uint256)`;
    } else if (pattern.feeArgSource === 'pair-stable') {
        sig = `function ${pattern.feeFunction}(bool stable) view returns (uint256)`;
    } else {
        sig = `function ${pattern.feeFunction}(address pair) view returns (uint256)`;
    }
    const iface = new Interface([sig]);
    const selector = iface.getFunction(pattern.feeFunction)!.selector;

    const rawResults: (bigint | null)[] = [];
    for (const sp of samplePairs) {
        // Build the call
        let target: string;
        let callData: string;
        if (pattern.feeTarget === 'pair') {
            target   = sp.pair;
            callData = selector;   // zero-arg
        } else {
            target = factory;
            if (pattern.feeArgSource === 'pair-stable') {
                callData = iface.encodeFunctionData(pattern.feeFunction, [Boolean(sp.stable)]);
            } else {
                callData = iface.encodeFunctionData(pattern.feeFunction, [sp.pair]);
            }
        }

        try {
            const returnData = await provider.call({ to: target, data: callData });
            if (!returnData || returnData === '0x') {
                rawResults.push(null);
                continue;
            }
            const raw = iface.decodeFunctionResult(pattern.feeFunction, returnData)[0] as bigint;
            rawResults.push(raw);
        } catch {
            rawResults.push(null);
        }
    }

    // Need at least one successful call to proceed
    const successful = rawResults.filter(r => r !== null) as bigint[];
    if (successful.length === 0) return null;

    // Compute adjusted (as-decimal) fees. bigint → number is safe here because
    // these are always small values (fee raws are typically < 1e18).
    const divisor = pattern.feeDivisor;
    const adjusted = successful.map(raw => Number(raw) / divisor);

    // Are they in the plausible range? All must be.
    const allPlausible = adjusted.every(v => v >= MIN_PLAUSIBLE_FEE && v <= MAX_PLAUSIBLE_FEE);
    if (!allPlausible) return null;

    // Determine confidence:
    //   high   — all pairs match, all values in typical band
    //   medium — all pairs match, some values outside typical (still plausible)
    //   low    — only one pair matched successfully (couldn't cross-check),
    //            OR wide value range (>10x span across pairs)
    let confidence: ProbeMatch['confidence'];
    let reason: string;
    const min = Math.min(...adjusted);
    const max = Math.max(...adjusted);
    const rangeRatio = min > 0 ? max / min : Infinity;

    if (successful.length < samplePairs.length / 2) {
        confidence = 'low';
        reason = `only ${successful.length}/${samplePairs.length} sample pair(s) returned a value`;
    } else if (rangeRatio > 10) {
        confidence = 'low';
        reason = `wide fee variance across pairs (${min.toFixed(6)} to ${max.toFixed(6)}, ${rangeRatio.toFixed(1)}x)`;
    } else if (adjusted.every(v => v >= TYPICAL_MIN && v <= TYPICAL_MAX)) {
        confidence = 'high';
        reason = `all ${successful.length} sample(s) in typical fee band (${min.toFixed(4)} to ${max.toFixed(4)})`;
    } else {
        confidence = 'medium';
        reason = `all ${successful.length} sample(s) plausible but at edge of typical range`;
    }

    return {
        patternName,
        pattern,
        sampleFeesRaw: successful,
        sampleFeesAdjusted: adjusted,
        confidence,
        reason,
    };
}

/**
 * Probe a factory + sample pairs against every registered pattern that matches
 * the family hint (if given). Returns matches in registry insertion order —
 * which is the priority order we care about (Equalizer first for solidly,
 * Shadow first for v2fee, etc.).
 *
 * Family hint filters candidates but is not authoritative: if you're not sure,
 * pass undefined and let the probe figure out which family fits.
 */
export async function probeFactoryInterface(
    provider: JsonRpcProvider,
    factory: string,
    samplePairs: SamplePair[],
    familyHint?: 'v2fee' | 'solidly',
): Promise<ProbeMatch[]> {
    if (samplePairs.length === 0) return [];

    const matches: ProbeMatch[] = [];
    for (const [name, pattern] of Object.entries(DEX_PATTERNS)) {
        // Family filter: skip patterns from wrong family
        if (familyHint && pattern.family !== familyHint) continue;

        const match = await tryPattern(provider, factory, samplePairs, name, pattern);
        if (match) matches.push(match);
    }

    return matches;
}

/**
 * Convenience: probe and return only the best match, or null if none found.
 * "Best" = highest confidence, ties broken by registry order (Paul's priority).
 */
export async function probeFactoryBestMatch(
    provider: JsonRpcProvider,
    factory: string,
    samplePairs: SamplePair[],
    familyHint?: 'v2fee' | 'solidly',
): Promise<ProbeMatch | null> {
    const matches = await probeFactoryInterface(provider, factory, samplePairs, familyHint);
    if (matches.length === 0) return null;

    // Sort by confidence rank; ties stay in registry order (stable sort).
    const rank = { high: 0, medium: 1, low: 2 };
    matches.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
    return matches[0];
}
