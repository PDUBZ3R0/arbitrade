// -----------------------------------------------------------------------------
// Can a factory whose pairs are not purely constant-product be CONFIGURED
// correctly, rather than blacklisted?  (used by verify-fees --apply)
//
// Many "non-constant-product" verdicts are hybrids: one pair contract that
// runs x*y=k unless a per-pair flag selects the stable curve. The pipeline
// already handles that shape — a v2fee entry with hasStableFlag reads the flag
// per pair, the enumerator leaves stable pairs out, and the volatile ones
// trade as normal. What it cannot handle is a curve that is never x*y=k
// (BrownFi's oracle/inventory invariant, say): those stay blacklisted.
//
// Only what the chain answers counts — never Claude's prose:
//   1. Camelot shape: every sample pair answers stableSwap(), token0FeePercent(),
//      token1FeePercent() and FEE_DENOMINATOR() with a plausible fee. This is
//      how Arbitrum's Camelot is configured (fee read from token0's side —
//      the fee is directional; a pair with a higher token1 fee overstates
//      edges in that direction, its simulation reverts and the hot loop mutes it).
//   2. Solidly shape: verify-factory's checks (stable() on the pair, Solidly
//      events, interface probe of the fee accessor) find a v2fee/solidly
//      config with a high/medium-confidence fee accessor AND a stable flag.
// Anything else: no reconfiguration.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';
import type { FactoryEntry } from './config.ts';
import { multicall3 } from './multicall.ts';

export type Reconfig = {
    group: 'v2fee' | 'solidly';
    entry: FactoryEntry;
    /** One line: what was measured. */
    basis: string;
};

const CAMELOT = new Interface([
    'function stableSwap() view returns (bool)',
    'function token0FeePercent() view returns (uint16)',
    'function token1FeePercent() view returns (uint16)',
    'function FEE_DENOMINATOR() view returns (uint256)',
]);
const MAX_FEE = 0.05;

async function probeCamelot(provider: JsonRpcProvider, address: string, deployBlock: number | undefined, pairs: string[]): Promise<Reconfig | null> {
    const fns = ['stableSwap', 'token0FeePercent', 'token1FeePercent', 'FEE_DENOMINATOR'] as const;
    const res = await multicall3(provider, pairs.flatMap(p => fns.map(fn => ({ target: p, allowFailure: true, callData: CAMELOT.encodeFunctionData(fn) }))));
    let denom: bigint | null = null, stable = 0, asym = 0;
    const fees: number[] = [];
    for (let i = 0; i < pairs.length; i++) {
        const out: Record<string, any> = {};
        for (let j = 0; j < fns.length; j++) {
            const r = res[i * fns.length + j];
            if (!r?.success || r.returnData === '0x') return null;
            try { out[fns[j]] = CAMELOT.decodeFunctionResult(fns[j], r.returnData)[0]; } catch { return null; }
        }
        const d = BigInt(out.FEE_DENOMINATOR);
        if (d <= 0n || (denom !== null && d !== denom)) return null;
        denom = d;
        const f0 = Number(out.token0FeePercent) / Number(d), f1 = Number(out.token1FeePercent) / Number(d);
        if (!(f0 > 0 && f0 <= MAX_FEE && f1 > 0 && f1 <= MAX_FEE)) return null;
        fees.push(f0);
        if (f0 !== f1) asym++;
        if (out.stableSwap) stable++;
    }
    if (denom === null) return null;
    return {
        group: 'v2fee',
        entry: {
            address, deployBlock,
            feeTarget: 'pair', feeFunction: 'token0FeePercent', feeDivisor: Number(denom),
            hasStableFlag: true, stableFunction: 'stableSwap',
        },
        basis: `Camelot-shaped pairs: stableSwap() + token0FeePercent()/${denom} on ${pairs.length}/${pairs.length} samples ` +
            `(fees ${[...new Set(fees.map(f => +(f * 100).toFixed(4)))].join('/')}%, ${stable} stable, ${asym} with a different token1 fee)`,
    };
}

/**
 * A configuration that prices this factory's constant-product pairs correctly
 * and keeps its other-curve pairs out — or null with the reason there is none.
 */
export async function proposeReconfig(
    chainLabel: string,
    provider: JsonRpcProvider,
    factory: { address: string; deployBlock?: number },
    samplePairs: string[],
    key: string,
): Promise<{ reconfig: Reconfig | null; why: string }> {
    const deployBlock = factory.deployBlock || undefined;
    if (samplePairs.length > 0) {
        try {
            const c = await probeCamelot(provider, factory.address, deployBlock, samplePairs);
            if (c) return { reconfig: c, why: c.basis };
        } catch (e) { /* fall through to the Solidly checks */ }
    }
    try {
        const { verifyFactory } = await import('./verify-factory.ts');
        const { proposeEntry } = await import('./find-factories.ts');
        const v = await verifyFactory(chainLabel, factory.address, process.env.ETHERSCAN_API_KEY);
        if (v.family !== 'v2fee' && v.family !== 'solidly') return { reconfig: null, why: `no stable/volatile flag found (verify-factory family: ${v.family})` };
        const p = proposeEntry(
            { address: factory.address, pairCreatedCount: 0, firstBlockSeen: 0, lastBlockSeen: 0, matchedTopics: new Set(v.poolEvent === 'velodrome' ? ['velodrome'] : []) } as any,
            key, v, null, false,
        );
        if (!p.addable || !p.proposed) return { reconfig: null, why: `Solidly-shaped, but ${p.heldBack ?? 'no usable config'}` };
        const group = p.proposed.group as 'v2fee' | 'solidly';
        if (group === 'v2fee' && !p.proposed.entry.hasStableFlag) return { reconfig: null, why: 'per-pair fee found, but no stable flag to separate the other curve' };
        return { reconfig: { group, entry: { ...p.proposed.entry, deployBlock: deployBlock ?? p.proposed.entry.deployBlock }, basis: p.proposed.basis }, why: p.proposed.basis };
    } catch (e) {
        return { reconfig: null, why: `probe failed: ${(e as Error).message.slice(0, 120)}` };
    }
}
