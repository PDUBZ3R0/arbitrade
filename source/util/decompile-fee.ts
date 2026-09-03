// -----------------------------------------------------------------------------
// Fee derivation via sevm bytecode decompilation.
//
// Pure-V2 fork pair contracts hardcode their swap fee as a literal constant
// inside swap(uint256,uint256,address,bytes) — the classic pattern is:
//
//   uint amountInWithFee = amountIn * 997;
//   uint numerator = amountInWithFee * reserveOut;
//   uint denominator = reserveIn * 1000 + amountInWithFee;
//   amountOut = numerator / denominator;
//
// so the fee is recoverable as 1 - (997/1000) = 0.003, directly from the
// bytecode, without needing a public getter (most V2 forks don't expose one)
// and without guessing. This replaces "assume 0.003, flag UNVERIFIED" with
// an actual read of what the contract does.
//
// Approach: decompile the pair's bytecode with sevm, isolate the `swap`
// function's statements (not the whole contract — avoids picking up
// unrelated constants from constructor/other functions), render to
// Solidity-like text, then scan for integer-literal pairs (N, D) where
// N/D lands in a plausible fee-complement range. Multiple V2 forks share
// common tiers (997/1000, 998/1000, 9975/10000, 9970/10000, 995/1000, ...),
// so this is deliberately a search over ANY plausible pair rather than a
// fixed list — new/unusual fee tiers still get caught.
//
// This is a heuristic over decompiled pseudocode, not a proof. Multiple
// candidate literals can appear (e.g. the K-invariant check in swap() often
// also multiplies by 1000**2), so confidence is 'derived' only when exactly
// one plausible candidate survives, or when a single clear winner falls in
// the typical fee band; otherwise 'ambiguous' — surfaced for human review
// rather than silently guessed.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';
import { Contract as SevmContract, solStmts } from 'sevm';
import 'sevm/4bytedb';

const SWAP_IFACE = new Interface([
    'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)',
]);
const SWAP_SELECTOR = SWAP_IFACE.getFunction('swap')!.selector;

// Common V2-fork fee denominators. A literal must match one of these to be
// considered a candidate denominator — keeps the search from matching
// unrelated large numbers (block timestamps, address-derived constants, etc).
const PLAUSIBLE_DENOMINATORS = [1000, 10000, 100000, 1000000] as const;

// Numerator/denominator ratio must fall in this range to be a plausible fee
// complement. 0.90 → 10% fee (extreme high end); 0.99999 → 0.001% (extreme
// low end, e.g. Retro priority-stable tier). Matches the plausibility window
// used by interface-probe.ts for the same reason: keeps garbage matches out.
const MIN_RATIO = 0.90;
const MAX_RATIO = 0.99999;

// A "typical" fee sits in this narrower band — used to disambiguate when
// multiple candidates survive the plausibility filter.
const TYPICAL_FEE_MIN = 0.0001;
const TYPICAL_FEE_MAX = 0.01;

export type DecompiledFeeMatch = {
    numerator: number;
    denominator: number;
    fee: number;   // 1 - numerator/denominator
};

export type DecompiledFeeResult = {
    address: string;
    hasSwapFunction: boolean;
    matches: DecompiledFeeMatch[];
    fee: number | null;
    /**
     * 'derived'   — exactly one plausible candidate, or one clear winner in
     *               the typical band among several plausible candidates.
     * 'ambiguous' — multiple plausible candidates, no clear winner. `fee` is
     *               set to the best guess but MUST be treated as unverified;
     *               read `snippet` before trusting it.
     * 'unknown'   — no swap() function found, or no plausible candidates at
     *               all (fee mechanism doesn't match the standard V2 shape —
     *               could be a v2fee/solidly-family pair, or something novel).
     */
    confidence: 'derived' | 'ambiguous' | 'unknown';
    /** Decompiled swap() body, for human review when confidence isn't 'derived'. */
    snippet: string;
    error?: string;
};

function extractFeeCandidates(src: string): DecompiledFeeMatch[] {
    const nums = Array.from(src.matchAll(/\b(\d{2,7})\b/g)).map(m => parseInt(m[1], 10));
    const seen = new Set<string>();
    const candidates: DecompiledFeeMatch[] = [];
    for (const d of PLAUSIBLE_DENOMINATORS) {
        if (!nums.includes(d)) continue;
        for (const n of nums) {
            if (n >= d) continue;
            const ratio = n / d;
            if (ratio < MIN_RATIO || ratio > MAX_RATIO) continue;
            const key = `${n}/${d}`;
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push({ numerator: n, denominator: d, fee: 1 - ratio });
        }
    }
    return candidates;
}

/**
 * Decompile a pair contract's swap() function via sevm and try to recover
 * its hardcoded fee constant. Safe to call on any address — returns
 * confidence: 'unknown' with an `error` for anything that isn't a standard
 * V2-shaped pair (no swap() function, decompile failure, no code, etc).
 */
export async function deriveFeeFromBytecode(
    provider: JsonRpcProvider,
    pairAddress: string,
): Promise<DecompiledFeeResult> {
    const result: DecompiledFeeResult = {
        address: pairAddress,
        hasSwapFunction: false,
        matches: [],
        fee: null,
        confidence: 'unknown',
        snippet: '',
    };

    let bytecode: string;
    try {
        bytecode = await provider.getCode(pairAddress);
    } catch (err) {
        result.error = `getCode failed: ${(err as Error).message}`;
        return result;
    }
    if (bytecode === '0x' || bytecode.length < 4) {
        result.error = 'no bytecode at address';
        return result;
    }

    let contract: SevmContract;
    try {
        contract = new SevmContract(bytecode).patchdb();
    } catch (err) {
        result.error = `sevm decompile failed: ${(err as Error).message.slice(0, 200)}`;
        return result;
    }

    const swapFn = contract.functions[SWAP_SELECTOR];
    if (!swapFn) {
        result.error = `no swap(uint256,uint256,address,bytes) function found at selector ${SWAP_SELECTOR} — not a standard V2 pair shape`;
        return result;
    }
    result.hasSwapFunction = true;

    let body: string;
    try {
        body = solStmts(swapFn.stmts);
    } catch (err) {
        result.error = `failed to render swap() body: ${(err as Error).message.slice(0, 200)}`;
        return result;
    }
    result.snippet = body;

    const candidates = extractFeeCandidates(body);
    result.matches = candidates;

    if (candidates.length === 0) {
        result.confidence = 'unknown';
        result.error = 'no plausible fee-constant pair found in swap() body';
    } else if (candidates.length === 1) {
        result.fee = candidates[0].fee;
        result.confidence = 'derived';
    } else {
        const typical = candidates.filter(c => c.fee >= TYPICAL_FEE_MIN && c.fee <= TYPICAL_FEE_MAX);
        if (typical.length === 1) {
            result.fee = typical[0].fee;
            result.confidence = 'derived';
        } else {
            // Multiple plausible candidates with no single typical-band
            // winner — best guess is the first, but this needs a human to
            // actually read `snippet` before it's trusted.
            result.fee = candidates[0].fee;
            result.confidence = 'ambiguous';
        }
    }

    return result;
}
