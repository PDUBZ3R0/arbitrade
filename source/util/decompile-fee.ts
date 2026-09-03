// -----------------------------------------------------------------------------
// Fee derivation via sevm bytecode decompilation.
//
// Pure-V2 fork pair contracts hardcode their swap fee as a literal constant
// inside swap(uint256,uint256,address,bytes). There are two encodings seen
// in the wild, and both need to be checked:
//
//   1. DIRECT (the actual UniswapV2Pair.sol K-invariant check):
//        uint balance0Adjusted = balance0.mul(1000).sub(amount0In.mul(3));
//        uint balance1Adjusted = balance1.mul(1000).sub(amount1In.mul(3));
//        require(balance0Adjusted.mul(balance1Adjusted) >= reserve0.mul(reserve1).mul(1000**2));
//      Fee = 3/1000 = 0.003 — the fee numerator appears directly, small,
//      paired with a separate "scale" constant (1000) via subtraction, not
//      division. This is what actually lives in the PAIR contract itself.
//
//   2. COMPLEMENT (the getAmountOut()-style helper, more commonly seen in a
//      router/library contract than the pair itself, but some forks inline
//      it into the pair):
//        uint amountInWithFee = amountIn * 997;
//        uint out = amountInWithFee * reserveOut / (reserveIn * 1000 + amountInWithFee);
//      Fee = 1 - 997/1000 = 0.003 — here the large complement (997) is what
//      appears, as a direct multiply-then-divide ratio.
//
// Both patterns get checked for every candidate (numerator, denominator)
// pair found in the decompiled text. Multiple V2 forks share common tiers
// (997/1000, 998/1000, 9975/10000, 3/1000, 2/1000, ...), so this is
// deliberately a search over ANY plausible pair rather than a fixed list.
//
// IMPORTANT: sevm's solidify/solStmts output renders integer literals in
// HEX (e.g. "0x3e8", "0x3"), not decimal — the extraction regex has to
// match hex, or it silently finds nothing in every contract regardless of
// what's actually there.
//
// This is a heuristic over decompiled pseudocode, not a proof. Common EVM
// boilerplate constants (calldata/memory offsets like 0x4, 0x20, 0x40) can
// coincidentally form a plausible-looking ratio against a real fee
// denominator, so confidence is 'derived' only when exactly one plausible
// candidate survives, or when a single clear winner falls in the typical fee
// band; otherwise 'ambiguous' — surfaced for human review rather than
// silently guessed.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';
import { Contract as SevmContract, solStmts } from 'sevm';
import 'sevm/4bytedb';

const SWAP_IFACE = new Interface([
    'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)',
]);
// sevm keys Contract.functions by the selector WITHOUT a "0x" prefix (see
// sevm/src/step.ts: `left.val.toString(16).padStart(8, '0')`) — ethers'
// .selector includes the prefix, so it has to be stripped before indexing.
const SWAP_SELECTOR = SWAP_IFACE.getFunction('swap')!.selector.replace(/^0x/, '');

// Common V2-fork fee denominators. A literal must match one of these to be
// considered a candidate denominator — keeps the search from matching
// unrelated large numbers (block timestamps, address-derived constants, etc).
const PLAUSIBLE_DENOMINATORS = [1000, 10000, 100000, 1000000] as const;

// COMPLEMENT-style ratio range (pattern 2 above): 0.90 → 10% fee (extreme
// high end); 0.99999 → 0.001% (extreme low end, e.g. Retro priority-stable
// tier). Matches the plausibility window used by interface-probe.ts for the
// same reason: keeps garbage matches out.
const MIN_COMPLEMENT_RATIO = 0.90;
const MAX_COMPLEMENT_RATIO = 0.99999;

// DIRECT-style fee range (pattern 1 above): the numerator IS the fee
// fraction, e.g. 3/1000 = 0.3%. Same bounds as the complement style, just
// expressed the other way round (small/large instead of large/large).
const MIN_DIRECT_FEE = 0.00001;
const MAX_DIRECT_FEE = 0.10;

// A "typical" fee sits in this narrower band — used to disambiguate when
// multiple candidates survive the plausibility filter.
const TYPICAL_FEE_MIN = 0.0001;
const TYPICAL_FEE_MAX = 0.01;

// Extremely common EVM boilerplate constants — calldata offsets, memory
// slots, ABI-encoding padding. These show up in essentially every function
// regardless of what it does, and if excluded as candidate NUMERATORS they'd
// otherwise coincidentally pair with a real denominator (e.g. 4/1000 = 0.4%
// is a plausible-looking fee, but 4 is almost always a calldata offset, not
// a fee numerator). Not excluded as denominators — they're too small to
// match PLAUSIBLE_DENOMINATORS anyway.
const COMMON_BOILERPLATE_NUMS = new Set([0, 1, 2, 4, 20, 32, 64, 96, 128, 160, 192, 224, 256]);

export type DecompiledFeeMatch = {
    numerator: number;
    denominator: number;
    fee: number;
    /** Which encoding this candidate matched under — for diagnostics/logging. */
    style: 'direct' | 'complement';
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
    // sevm renders literals in hex. Match hex primarily; also accept plain
    // decimal defensively in case any literal ever renders that way.
    const hexNums = Array.from(src.matchAll(/\b0x([0-9a-fA-F]+)\b/g))
        .map(m => parseInt(m[1], 16))
        .filter(n => Number.isFinite(n) && n > 0 && n < 1_000_000_000);
    const decNums = Array.from(src.matchAll(/\b(\d{1,9})\b/g)).map(m => parseInt(m[1], 10));
    const nums = [...new Set([...hexNums, ...decNums])];

    const seen = new Set<string>();
    const candidates: DecompiledFeeMatch[] = [];
    for (const d of PLAUSIBLE_DENOMINATORS) {
        if (!nums.includes(d)) continue;
        for (const n of nums) {
            if (n <= 0 || n >= d) continue;
            if (COMMON_BOILERPLATE_NUMS.has(n)) continue;

            const directFee = n / d;
            const key = `${n}/${d}`;
            if (seen.has(key)) continue;

            if (directFee >= MIN_DIRECT_FEE && directFee <= MAX_DIRECT_FEE) {
                seen.add(key);
                candidates.push({ numerator: n, denominator: d, fee: directFee, style: 'direct' });
            } else if (directFee >= MIN_COMPLEMENT_RATIO && directFee <= MAX_COMPLEMENT_RATIO) {
                seen.add(key);
                candidates.push({ numerator: n, denominator: d, fee: 1 - directFee, style: 'complement' });
            }
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
        result.error = `no swap(uint256,uint256,address,bytes) function found at selector 0x${SWAP_SELECTOR} — not a standard V2 pair shape`;
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
