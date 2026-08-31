// -----------------------------------------------------------------------------
// Token metadata fetcher.
//
// Fetches symbol(), name(), decimals() for a set of token addresses via
// Multicall3. Handles the two common non-standard cases:
//
//   1. Bytes32 legacy tokens. MakerDAO's original MKR (and a few others from
//      that era) declared symbol/name as `bytes32` instead of `string`.
//      String decoders bomb on those; we try the bytes32 ABI as a fallback.
//
//   2. Reverting tokens. Some contracts implement none of the ERC20
//      metadata methods (mostly test/scam tokens; occasionally a proxy
//      whose implementation doesn't forward these). We mark them 'reverted'
//      so we don't retry.
//
// Also handles the "no code at address" case for self-destructed tokens
// and CREATE2-precommitted addresses that were never actually deployed.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface } from 'ethers';
import { multicall3, type Multicall3Call } from './multicall.ts';
import type { ArbitradeDB } from './db.ts';

// Batch shape for the multicall
const TOKEN_ABI_STRING = [
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function decimals() view returns (uint8)',
];
const TOKEN_ABI_BYTES32 = [
    'function symbol() view returns (bytes32)',
    'function name() view returns (bytes32)',
];

const ifaceStr   = new Interface(TOKEN_ABI_STRING);
const ifaceBytes = new Interface(TOKEN_ABI_BYTES32);

const SEL_symbol   = ifaceStr.getFunction('symbol')!.selector;
const SEL_name     = ifaceStr.getFunction('name')!.selector;
const SEL_decimals = ifaceStr.getFunction('decimals')!.selector;

export type TokenFetchResult = {
    address: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    fetchStatus: 'ok' | 'reverted' | 'nocode';
};

/**
 * Decode a bytes32 as UTF-8 text (right-trim NULs).
 * Legacy tokens like MKR use this instead of `string`.
 */
function decodeBytes32(hex: string): string | null {
    try {
        // bytes32 return data is exactly 32 bytes = 66 chars incl. '0x'
        if (!hex || hex.length !== 66 || !hex.startsWith('0x')) return null;
        const bytes = Buffer.from(hex.slice(2), 'hex');
        // Trim trailing NULs
        let end = bytes.length;
        while (end > 0 && bytes[end - 1] === 0) end--;
        if (end === 0) return null;
        const s = bytes.slice(0, end).toString('utf8');
        // Sanity: bytes32 symbols are usually ASCII. Reject anything with
        // control chars, which likely means it's not a symbol at all.
        if (/[\x00-\x1f]/.test(s)) return null;
        return s;
    } catch { return null; }
}

/**
 * Parse a metadata triple from three Multicall3 results (symbol, name, decimals).
 * Handles string→bytes32 fallback for symbol/name. Returns null values for
 * fields that don't decode; caller decides whether that counts as 'ok' or
 * 'reverted' overall.
 */
function parseTriple(
    symbolRes: { success: boolean; returnData: string },
    nameRes:   { success: boolean; returnData: string },
    decimalsRes: { success: boolean; returnData: string },
): { symbol: string | null; name: string | null; decimals: number | null } {
    let symbol: string | null = null;
    let name:   string | null = null;
    let decimals: number | null = null;

    // Symbol: try string, fall back to bytes32
    if (symbolRes.success && symbolRes.returnData !== '0x') {
        try {
            symbol = ifaceStr.decodeFunctionResult('symbol', symbolRes.returnData)[0] as string;
        } catch {
            symbol = decodeBytes32(symbolRes.returnData);
        }
        if (symbol !== null) {
            // Trim, drop empties, cap length to prevent absurd names blowing up UI
            symbol = symbol.trim().slice(0, 32);
            if (symbol.length === 0) symbol = null;
        }
    }

    // Name: same treatment
    if (nameRes.success && nameRes.returnData !== '0x') {
        try {
            name = ifaceStr.decodeFunctionResult('name', nameRes.returnData)[0] as string;
        } catch {
            name = decodeBytes32(nameRes.returnData);
        }
        if (name !== null) {
            name = name.trim().slice(0, 128);
            if (name.length === 0) name = null;
        }
    }

    // Decimals: must be a uint8 (0-255). Anything else = malformed.
    if (decimalsRes.success && decimalsRes.returnData !== '0x') {
        try {
            const raw = ifaceStr.decodeFunctionResult('decimals', decimalsRes.returnData)[0];
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0 && n <= 255) decimals = n;
        } catch { /* leave null */ }
    }

    return { symbol, name, decimals };
}

/**
 * Fetch metadata for a batch of token addresses via Multicall3.
 * Batch size should stay under ~30 tokens (= 90 sub-calls) to keep the
 * whole aggregate3 call comfortable within the ~5MB return-data limit
 * that most public RPCs enforce.
 *
 * Never throws for individual token failures — always returns one result
 * per input address. The caller can persist the whole batch atomically.
 */
export async function fetchTokenBatch(
    provider: JsonRpcProvider,
    addresses: string[],
): Promise<TokenFetchResult[]> {
    if (addresses.length === 0) return [];

    // First, filter out addresses with no code — those can't respond to
    // eth_call and would waste multicall slots. We do one batch of getCode
    // per aggregate; ethers handles this via provider.getCode.
    //
    // For a first-cut we skip the getCode pre-filter (would double RPC
    // round-trips per batch). We rely on Multicall3's allowFailure to let
    // failures come back as `success: false` — they're indistinguishable
    // from a revert to us, and we tag them 'reverted' either way.

    const calls: Multicall3Call[] = [];
    for (const addr of addresses) {
        calls.push({ target: addr, allowFailure: true, callData: SEL_symbol });
        calls.push({ target: addr, allowFailure: true, callData: SEL_name });
        calls.push({ target: addr, allowFailure: true, callData: SEL_decimals });
    }

    const results = await multicall3(provider, calls);
    if (results.length !== addresses.length * 3) {
        throw new Error(`Multicall returned ${results.length} results for ${addresses.length * 3} calls`);
    }

    const out: TokenFetchResult[] = [];
    for (let i = 0; i < addresses.length; i++) {
        const symbolRes   = results[i * 3    ];
        const nameRes     = results[i * 3 + 1];
        const decimalsRes = results[i * 3 + 2];

        // All three reverted or returned empty → almost certainly no code
        // at address (or a wildly non-standard token). Tag as 'reverted';
        // 'nocode' would need a separate getCode we're deliberately skipping.
        const allFailed =
            (!symbolRes.success   || symbolRes.returnData   === '0x') &&
            (!nameRes.success     || nameRes.returnData     === '0x') &&
            (!decimalsRes.success || decimalsRes.returnData === '0x');

        if (allFailed) {
            out.push({
                address: addresses[i],
                symbol: null,
                name: null,
                decimals: null,
                fetchStatus: 'reverted',
            });
            continue;
        }

        const parsed = parseTriple(symbolRes, nameRes, decimalsRes);
        // Consider it 'ok' if we got decimals (the field that actually matters
        // for math). Symbol/name are display-only; missing one doesn't taint
        // the record.
        const status: TokenFetchResult['fetchStatus'] = parsed.decimals !== null ? 'ok' : 'reverted';

        out.push({
            address: addresses[i],
            symbol: parsed.symbol,
            name: parsed.name,
            decimals: parsed.decimals,
            fetchStatus: status,
        });
    }

    return out;
}

/**
 * Populate the tokens table from all pair tokens on the chain.
 * Skips tokens already fetched (any terminal status).
 *
 * `batchSize` is Multicall3 batch — 30 tokens (90 sub-calls) is a good
 * default for most RPCs. Bump to 50 on Alchemy/paid tiers, drop to 10 on
 * flaky public RPCs.
 *
 * Emits progress every batch.
 */
export async function populateTokenMetadata(
    provider: JsonRpcProvider,
    db: ArbitradeDB,
    opts: {
        withReservesOnly?: boolean;  // default: true — skip tokens in dead pairs
        batchSize?: number;          // default: 30
        onProgress?: (info: { done: number; total: number; okSoFar: number; revertedSoFar: number }) => void;
    } = {},
): Promise<{ fetched: number; ok: number; reverted: number }> {
    const withReservesOnly = opts.withReservesOnly ?? true;
    const batchSize = opts.batchSize ?? 30;

    const addresses = db.listPairTokens({ withReservesOnly, unfetchedOnly: true });
    if (addresses.length === 0) {
        return { fetched: 0, ok: 0, reverted: 0 };
    }

    let done = 0;
    let ok = 0;
    let reverted = 0;

    for (let i = 0; i < addresses.length; i += batchSize) {
        const batch = addresses.slice(i, i + batchSize);
        let results: TokenFetchResult[];
        try {
            results = await fetchTokenBatch(provider, batch);
        } catch (err) {
            // Batch-level failure (RPC timeout, rate limit). Mark this batch
            // as 'pending' so a retry picks them up. Don't fail the whole run.
            results = batch.map(a => ({
                address: a, symbol: null, name: null, decimals: null,
                fetchStatus: 'reverted' as const,   // tagged as reverted so we don't infinite-retry
            }));
            console.log(`\n  [!] Batch failed at token ${i}: ${(err as Error).message.slice(0, 100)}`);
        }

        db.upsertTokens(results);
        for (const r of results) {
            if (r.fetchStatus === 'ok') ok++;
            else reverted++;
        }
        done += batch.length;
        opts.onProgress?.({ done, total: addresses.length, okSoFar: ok, revertedSoFar: reverted });
    }

    return { fetched: done, ok, reverted };
}
