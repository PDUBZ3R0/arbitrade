// -----------------------------------------------------------------------------
// The audits find-factories runs on a candidate before it can go in the conf:
// the work of verify-fees and pair-code, and of check-fee-config where the
// candidate's fee call was only tried on recently created pairs.
//
// Pairs: the candidate's pools between hub tokens, deepest first, since a
// recent pair has rarely traded; then the recent ones the verifier sampled.
//
// Verdicts only ever hold a candidate back, or correct its v2 fee. A question
// the audit couldn't answer (no swaps, no decompiler) changes nothing, and
// nothing here blacklists: a held-back candidate is reported for a human.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import type { JsonRpcProvider } from 'ethers';
import type { NormalizedFactory } from './config.ts';
import { LivePools } from '../liquidation/live-pools.ts';
import { auditFee, checkFeeAccessor, type AccessorVerdict, type FeeAuditOptions, type FeeRow } from './fee-audit.ts';
import { pickFeeSamplePairs } from './empirical-fee.ts';
import { readPairCode, type PairCodeCache, type PairCodeRead } from './pair-code.ts';
import { tokenPairs, type Sample } from './sample-pairs.ts';

export type CandidateEntry = {
    address: string; fee?: number; poolEvent?: string; hasStableFlag?: boolean;
    feeTarget?: 'factory' | 'pair'; feeArgSource?: NormalizedFactory['feeArgSource']; feeFunction?: string; feeDivisor?: number;
};
export type Audit = { fee?: FeeRow; accessor?: AccessorVerdict; code?: PairCodeRead; notes: string[] };
export type AuditEffect = { hold?: string; setFee?: number; basis?: string };

/** A proposed conf entry as config.ts would resolve it, with the same group defaults. */
export function asFactory(group: NormalizedFactory['group'], key: string, e: CandidateEntry): NormalizedFactory {
    return {
        group, name: key, address: e.address, deployBlock: 0, fee: e.fee, stableFees: undefined,
        feeTarget: e.feeTarget ?? 'factory', feeArgSource: e.feeArgSource ?? 'pair-address',
        feeFunction: e.feeFunction ?? (group === 'solidly' ? 'getRealFee' : 'pairFee'),
        feeDivisor: e.feeDivisor ?? (group === 'solidly' ? 1e18 : group === 'v2fee' ? 1_000_000 : 10_000),
        hasStableFlag: !!e.hasStableFlag, stableFunction: 'stable', poolEvent: e.poolEvent as NormalizedFactory['poolEvent'],
        callback: undefined, algebraVariant: undefined, abi: [],
    };
}

/** What the audit means for the candidate. Pure, so every path is testable. */
export function auditEffect(group: string, a: Audit): AuditEffect {
    if (a.code?.report.verdict === 'trap') {
        return { hold: `pair code: ${a.code.report.findings.find(f => f.level === 'trap')?.what ?? 'trap'} (yarn pair-code)` };
    }
    if (a.accessor?.status === 'UNREADABLE' || a.accessor?.status === 'FIX' || a.accessor?.status === 'REVIEW') {
        return { hold: `fee call on its busiest pairs: ${a.accessor.status}: ${a.accessor.detail}` };
    }
    if (group !== 'v2' || !a.fee) return {};
    const { status, detail, finalFee, source, assumedFee, claude } = a.fee;
    if (status === 'NO-SWAP') return { hold: 'no swap() on its pairs: not executable' };
    if (status === 'NON-CP') return { hold: `not constant-product: ${detail}` };
    if (status === 'CONFLICT') return { hold: `fee signals disagree: ${detail}` };
    if (claude?.feeKind === 'per-pair-storage' || claude?.feeKind === 'factory-lookup') return { hold: `fee is ${claude.feeKind}: it belongs in v2fee, not v2` };
    if (status === 'MISMATCH') return { setFee: finalFee!, basis: `fee ${assumedFee ?? 'unset'} → ${finalFee} (${source})` };
    if (status === 'MATCH') return { basis: `fee confirmed (${source})` };
    return {};
}

export type AuditContext = {
    provider: JsonRpcProvider;
    hubs: string[];
    fees: FeeAuditOptions;
    codeCacheFile: string;
    /** Trusted when picking pairs to measure swaps on; see pickFeeSamplePairs. */
    trusted: Set<string>;
};

export async function auditCandidate(ctx: AuditContext, factory: NormalizedFactory, recent: Sample[]): Promise<Audit> {
    const { provider, hubs } = ctx;
    const a: Audit = { notes: [] };
    if (factory.group === 'v3' || factory.group === 'algebra') return a;

    const live = new LivePools(provider, [factory]);
    await live.load(tokenPairs(hubs));
    const deep = (live.byFactory().get(factory.address.toLowerCase()) ?? []).map(r => ({ pair: r.address, token0: r.token0, token1: r.token1, stable: r.stable == null ? null : r.stable === 1 }));
    const seen = new Set(deep.map(d => d.pair.toLowerCase()));
    const samples = [...deep, ...recent.filter(r => !seen.has(r.pair.toLowerCase()))];
    if (!samples.length) { a.notes.push('audit: no pairs to read'); return a; }
    a.notes.push(`audit: ${deep.length} hub-token pool(s), ${recent.length} recent pair(s)`);

    if (factory.group === 'v2') {
        const { picked, excluded } = pickFeeSamplePairs(samples, new Map(), ctx.trusted);
        a.fee = await auditFee({ ...ctx.fees, group: 'v2' }, { name: factory.name, address: factory.address, fee: factory.fee }, samples[0].pair, samples.slice(0, 5).map(s => s.pair), picked, excluded);
    } else if (factory.fee == null) {
        a.accessor = await checkFeeAccessor(provider, factory as NormalizedFactory & { group: 'v2fee' | 'solidly' }, samples.slice(0, 3));
    }

    const cache: PairCodeCache = fs.existsSync(ctx.codeCacheFile) ? JSON.parse(fs.readFileSync(ctx.codeCacheFile, 'utf8')) : {};
    const s = samples[0];
    a.code = await readPairCode(provider, { address: s.pair, token0: s.token0, token1: s.token1 }, factory.address.toLowerCase(), cache,
        { save: () => fs.writeFileSync(ctx.codeCacheFile, JSON.stringify(cache)) });
    return a;
}
