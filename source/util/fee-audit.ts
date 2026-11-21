// -----------------------------------------------------------------------------
// The per-factory checks behind verify-fees and check-fee-config, also run by
// find-factories on each candidate before it goes in the conf. See those CLIs'
// headers for what the verdicts mean.
// -----------------------------------------------------------------------------

import type { JsonRpcProvider } from 'ethers';
import type { NormalizedFactory } from './config.ts';
import { deriveFeeFromBytecode } from './decompile-fee.ts';
import { empiricallyVerifyFee, type HyperSyncConfig } from './empirical-fee.ts';
import { acquireCode, analyzeFeeWithClaude, type ClaudeFeeAnalysis } from './source-fee.ts';
import { tryPattern, probeFactoryInterface, type SamplePair } from './interface-probe.ts';
import type { DexPattern } from './dex-patterns.ts';

export type FeeStatus = 'MATCH' | 'MISMATCH' | 'CONFLICT' | 'NON-CP' | 'NO-SAMPLE' | 'NO-SWAP' | 'UNKNOWN';
export type FeeSource = 'decompile' | 'empirical' | 'claude' | 'claude+empirical' | 'none';
export type FeeRow = {
    name: string;
    address: string;
    assumedFee: number | undefined;
    finalFee: number | null;
    source: FeeSource;
    decompiledFee: number | null;
    decompiledConfidence: string;
    empiricalFee: number | null;
    empiricalConfidence: string;
    empiricalSampleCount: number;
    claude: ClaudeFeeAnalysis | null;
    claudeNote: string;
    status: FeeStatus;
    snippet: string;
    detail: string;
    /** Up to 5 of the factory's pairs, most active first — probed by --apply. */
    pairs: string[];
};

export type FeeAuditOptions = {
    provider: JsonRpcProvider;
    chainId: number;
    rpcUrl?: string;
    hypersync?: HyperSyncConfig;
    /** The factory group being audited: only `v2` has one fee per factory. */
    group: string;
    claude?: { all: boolean; allowHeimdall: boolean; apiKey: string; cacheFile: string };
    etherscanKey?: string;
};

const CONFLICT_TOLERANCE = 0.0002;

export function noSample(f: { name: string; address: string; fee?: number }, detail: string): FeeRow {
    return {
        name: f.name, address: f.address, assumedFee: f.fee, finalFee: null, source: 'none',
        decompiledFee: null, decompiledConfidence: '-', empiricalFee: null, empiricalConfidence: '-',
        empiricalSampleCount: 0, claude: null, claudeNote: '', status: 'NO-SAMPLE', snippet: '', detail, pairs: [],
    };
}

/**
 * Up to three signals for one factory, cheapest first, and the verdict.
 * `sample` is any pair of it; `active` its busiest; `feePairs` the ones safe
 * to measure swaps on, with `taxed` the reasons the rest were dropped.
 */
export async function auditFee(
    o: FeeAuditOptions,
    f: { name: string; address: string; fee?: number },
    sample: string,
    active: string[],
    feePairs: Array<{ pair: string }>,
    taxed: Array<{ why: string }>,
): Promise<FeeRow> {
    const { provider, group } = o;
    const useClaude = !!o.claude, claudeAll = !!o.claude?.all;
    const bestPair = active[0] ?? sample;

    // --- 1. sevm decompile (free)
    const decompiled = await deriveFeeFromBytecode(provider, sample);

    // --- 2. empirical (free) — only if sevm didn't settle it
    let empiricalFee: number | null = null;
    let empiricalConfidence = 'not attempted';
    let empiricalSampleCount = 0;
    let empiricalError: string | undefined;
    if (decompiled.confidence !== 'derived' || claudeAll) {
        if (feePairs.length === 0 && taxed.length > 0) {
            empiricalConfidence = 'unknown';
            empiricalError = `not measured: all ${taxed.length} pair(s) have a token the probe flagged (${[...new Set(taxed.map(t => t.why))].join(', ')})`;
        }
        for (const candidate of feePairs) {
            const empirical = await empiricallyVerifyFee(provider, candidate.pair, { hypersync: o.hypersync });
            empiricalFee = empirical.fee;
            empiricalConfidence = empirical.confidence;
            empiricalSampleCount = empirical.samples.length;
            empiricalError = empirical.error;
            if (empirical.confidence === 'derived') break;
            if (empirical.confidence === 'ambiguous') break; // real signal about the factory — don't pair-shop
        }
    }

    // --- 3. Claude (paid, opt-in)
    const freeResolved = decompiled.confidence === 'derived' || empiricalConfidence === 'derived';
    let claude: ClaudeFeeAnalysis | null = null;
    let claudeNote = '';
    if (useClaude && (!freeResolved || claudeAll)) {
        try {
            const acquired = await acquireCode({
                chainId: o.chainId,
                rpcUrl: o.rpcUrl,
                address: bestPair,
                etherscanApiKey: o.etherscanKey,
                allowHeimdall: o.claude!.allowHeimdall,
            });
            if (acquired.source === 'none') {
                claudeNote = `no readable code (${acquired.note ?? 'unknown reason'})`;
            } else {
                claude = await analyzeFeeWithClaude({ acquired, address: bestPair, cacheFile: o.claude!.cacheFile, apiKey: o.claude!.apiKey });
            }
        } catch (err) {
            claudeNote = `claude analysis failed: ${(err as Error).message.slice(0, 160)}`;
        }
    }

    // --- Resolution
    const confirmed: Array<{ src: FeeSource; fee: number }> = [];
    if (empiricalConfidence === 'derived' && empiricalFee !== null) confirmed.push({ src: 'empirical', fee: empiricalFee });
    const claudeTrusted = !!claude && claude.evidenceVerified && claude.confidence === 'high'
        && claude.fee !== null && claude.curve === 'constant-product' && claude.feeKind === 'constant';
    if (claudeTrusted) confirmed.push({ src: 'claude', fee: claude!.fee! });

    // Two independent weak signals that agree: Claude read the code at MEDIUM
    // confidence (evidence verified, but e.g. found in a helper rather than
    // squarely in swap()'s K-check) AND the one real swap we could find implies
    // the same fee. Deliberately narrow: exactly 1 empirical sample means "too
    // little data" — the "samples disagree" case (possible dynamic fee or
    // skimming pair) never qualifies.
    const claudeCorroborated = !claudeTrusted && !!claude && claude.evidenceVerified && claude.confidence === 'medium'
        && claude.fee !== null && claude.curve === 'constant-product' && claude.feeKind === 'constant'
        && empiricalConfidence === 'ambiguous' && empiricalSampleCount === 1 && empiricalFee !== null
        && Math.abs(claude.fee - empiricalFee) <= CONFLICT_TOLERANCE;
    if (claudeCorroborated) confirmed.push({ src: 'claude+empirical', fee: claude!.fee! });
    if (decompiled.confidence === 'derived' && decompiled.fee !== null) confirmed.push({ src: 'decompile', fee: decompiled.fee });

    const claudeSaysNonCp = !!claude && claude.evidenceVerified
        && (claude.confidence === 'high' || claude.confidence === 'medium')
        && (claude.curve === 'stable-solidly' || claude.curve === 'other');

    let status: FeeStatus;
    let finalFee: number | null = null;
    let source: FeeSource = 'none';
    let detail = '';

    if (claudeSaysNonCp) {
        status = 'NON-CP';
        detail = `curve=${claude!.curve} — constant-product math is wrong for these pairs; exclude from triangulation. ${claude!.notes}`;
    } else if (confirmed.length >= 2 && Math.max(...confirmed.map(c => c.fee)) - Math.min(...confirmed.map(c => c.fee)) > CONFLICT_TOLERANCE) {
        status = 'CONFLICT';
        detail = confirmed.map(c => `${c.src}=${c.fee}`).join(' vs ');
    } else if (confirmed.length > 0) {
        // Priority: observed behavior > read source > regex over bytecode.
        const pick = confirmed[0];
        finalFee = pick.fee;
        source = pick.src;
        status = f.fee !== undefined && Math.abs(finalFee - f.fee) < 1e-6 ? 'MATCH' : 'MISMATCH';
        if (confirmed.length >= 2) detail = `corroborated by ${confirmed.slice(1).map(c => c.src).join(', ')}`;
    } else {
        status = decompiled.hasSwapFunction ? 'UNKNOWN' : 'NO-SWAP';
        detail = [decompiled.error, empiricalError ? `empirical: ${empiricalError}` : undefined].filter(Boolean).join('; ');
    }
    if (claude && !claudeTrusted && !claudeCorroborated && !claudeSaysNonCp) {
        claudeNote = `claude: fee=${claude.fee} curve=${claude.curve} kind=${claude.feeKind} conf=${claude.confidence}${claude.evidenceVerified ? '' : ' (evidence NOT verified in code)'}${claude.notes ? ` — ${claude.notes}` : ''}`;
    }
    if (claude && (claude.feeKind === 'per-pair-storage' || claude.feeKind === 'factory-lookup') && group === 'v2') {
        claudeNote += `${claudeNote ? '; ' : ''}fee is ${claude.feeKind} — this factory likely belongs in the v2fee group, not v2`;
    }

    return {
        name: f.name, address: f.address, assumedFee: f.fee, finalFee, source,
        decompiledFee: decompiled.fee, decompiledConfidence: decompiled.confidence,
        empiricalFee, empiricalConfidence, empiricalSampleCount,
        claude, claudeNote, status, snippet: decompiled.snippet, detail,
        pairs: active.length ? active : [sample],
    };
}

export type AccessorStatus = 'OK' | 'FIX' | 'REVIEW' | 'UNREADABLE' | 'NO-SAMPLE';
export type AccessorVerdict = { status: AccessorStatus; detail: string; fix?: { name: string; pattern: DexPattern } };
type Accessor = Pick<NormalizedFactory, 'address' | 'feeTarget' | 'feeArgSource' | 'feeFunction' | 'feeDivisor'> & { group: 'v2fee' | 'solidly' };

export const describeAccessor = (p: Pick<DexPattern, 'feeTarget' | 'feeArgSource' | 'feeFunction' | 'feeDivisor'>) =>
    `${p.feeTarget === 'pair' ? 'pair' : 'factory'}.${p.feeFunction}(${p.feeTarget === 'pair' ? '' : p.feeArgSource ?? 'pair-address'}) / ${p.feeDivisor}`;
const fmtFees = (xs: number[]) => [...new Set(xs.map(x => +(x * 100).toFixed(4)))].join('/') + '%';

/** Does a per-pair-fee factory answer its configured fee call on these pairs, and if not, what does? */
export async function checkFeeAccessor(provider: JsonRpcProvider, f: Accessor, samples: SamplePair[]): Promise<AccessorVerdict> {
    /** The accessor config.ts resolved for this factory, as a probe pattern. */
    const pattern = { family: f.group, feeTarget: f.feeTarget, feeArgSource: f.feeArgSource, feeFunction: f.feeFunction, feeDivisor: f.feeDivisor } as DexPattern;
    const mine = await tryPattern(provider, f.address, samples, 'configured', pattern);
    if (mine && mine.sampleFeesAdjusted.length * 2 >= samples.length) {
        return { status: 'OK', detail: `${describeAccessor(f)} → ${fmtFees(mine.sampleFeesAdjusted)} on ${mine.sampleFeesAdjusted.length}/${samples.length}` };
    }
    const why = mine ? `configured ${describeAccessor(f)} answered on only ${mine.sampleFeesAdjusted.length}/${samples.length} pairs`
        : `configured ${describeAccessor(f)} returned nothing plausible on ${samples.length}/${samples.length} pairs`;
    const matches = await probeFactoryInterface(provider, f.address, samples, f.group);
    const rank = { high: 0, medium: 1, low: 2 };
    matches.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
    const best = matches[0];
    if (!best) return { status: 'UNREADABLE', detail: `${why}; no registered pattern answers either` };
    return {
        status: best.confidence === 'low' ? 'REVIEW' : 'FIX',
        detail: `${why}; ${best.patternName} answers: ${describeAccessor(best.pattern)} → ${fmtFees(best.sampleFeesAdjusted)} [${best.confidence}: ${best.reason}]`,
        fix: { name: best.patternName, pattern: best.pattern },
    };
}
