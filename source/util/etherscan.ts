// -----------------------------------------------------------------------------
// Etherscan V2 unified API client.
//
// Etherscan launched a V2 API in 2024 that unified access across all supported
// chains (Ethereum, Polygon, Arbitrum, Optimism, Base, BSC, Fantom/Sonic, ...)
// under a single endpoint and a single API key. The chain is passed as
// `chainid=N` query param.
//
// Docs: https://docs.etherscan.io/etherscan-v2
//
// Free tier: 5 calls/sec, 100k calls/day. Plenty for our use.
// -----------------------------------------------------------------------------

const V2_BASE = 'https://api.etherscan.io/v2/api';

/**
 * Look up when a contract was created.
 *
 * Returns { blockNumber, txHash, creator } or null if not found.
 *
 * Note: Etherscan V2's `getcontractcreation` action returns `blockNumber`
 * directly for most chains. If it's missing for the chain we're querying,
 * we fall back to fetching the transaction via `eth_getTransactionByHash`.
 */
export async function getContractCreation(
    chainId: number,
    address: string,
    apiKey: string,
): Promise<{ blockNumber: number; txHash: string; creator: string } | null> {
    const url = new URL(V2_BASE);
    url.searchParams.set('chainid', String(chainId));
    url.searchParams.set('module', 'contract');
    url.searchParams.set('action', 'getcontractcreation');
    url.searchParams.set('contractaddresses', address);
    url.searchParams.set('apikey', apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
        throw new Error(`Etherscan V2 HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const data = await res.json() as any;

    // Etherscan quirk: on "no results" they return status="0", message="No data found",
    // result=[] or result="No data found" (string). Don't treat that as an error.
    if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) {
        return null;
    }

    const entry = data.result[0];
    const txHash = entry.txHash as string;
    const creator = (entry.contractCreator || entry.creator) as string;

    // Prefer explorer-provided block number when present
    if (entry.blockNumber !== undefined && entry.blockNumber !== null) {
        const bn = Number(entry.blockNumber);
        if (Number.isFinite(bn) && bn > 0) {
            return { blockNumber: bn, txHash, creator };
        }
    }

    // Fallback: fetch the transaction to get its block number
    if (!txHash) return null;
    const tx = await getTransactionByHash(chainId, txHash, apiKey);
    if (tx && tx.blockNumber) {
        return { blockNumber: tx.blockNumber, txHash, creator };
    }
    return null;
}

async function getTransactionByHash(
    chainId: number,
    txHash: string,
    apiKey: string,
): Promise<{ blockNumber: number } | null> {
    const url = new URL(V2_BASE);
    url.searchParams.set('chainid', String(chainId));
    url.searchParams.set('module', 'proxy');
    url.searchParams.set('action', 'eth_getTransactionByHash');
    url.searchParams.set('txhash', txHash);
    url.searchParams.set('apikey', apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json() as any;
    const bn = data?.result?.blockNumber;
    if (!bn) return null;
    return { blockNumber: parseInt(bn, 16) };
}

// -----------------------------------------------------------------------------
// getLogs via Etherscan V2
//
// The `logs` module returns matching events without any pruning. This works
// with the same free-tier API key. Constraints:
//   - Rate limit: 5 calls/sec (free tier), 100k calls/day
//   - Result cap: 1000 logs per call. If you hit exactly 1000, the response
//     may be truncated; shrink your block range and retry to be safe.
// -----------------------------------------------------------------------------

export type EtherscanLog = {
    address: string;
    topics: string[];
    data: string;
    blockNumber: number;   // decoded from hex
    transactionHash: string;
    logIndex: number;      // decoded from hex
};

/**
 * Fetch logs via Etherscan V2. Returns up to 1000 logs per call.
 *
 * `address` is optional. When omitted, matches events from ANY contract
 * (useful for factory discovery — sweep the whole chain for PairCreated
 * emitters, then group by emitter to find unknown factories).
 */
export async function etherscanGetLogs(params: {
    chainId: number;
    address?: string;
    topic0: string;
    fromBlock: number;
    toBlock: number;
    apiKey: string;
}): Promise<EtherscanLog[]> {
    const url = new URL(V2_BASE);
    url.searchParams.set('chainid', String(params.chainId));
    url.searchParams.set('module', 'logs');
    url.searchParams.set('action', 'getLogs');
    if (params.address) {
        url.searchParams.set('address', params.address);
    }
    url.searchParams.set('fromBlock', String(params.fromBlock));
    url.searchParams.set('toBlock', String(params.toBlock));
    url.searchParams.set('topic0', params.topic0);
    url.searchParams.set('apikey', params.apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
        throw new Error(`Etherscan V2 HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const data = await res.json() as any;

    // Etherscan quirk: "No records found" comes back as status="0" but result=[]
    if (data.status === '0' && Array.isArray(data.result)) return [];

    // Real errors: status="0" with message="NOTOK" and result="<actual reason>".
    // Rate-limit errors (status="0", message="NOTOK", result="Max rate limit reached")
    // are the most common. Surface BOTH fields so the caller can see what happened.
    if (data.status === '0') {
        const detail = [data.message, data.result]
            .filter(x => x && typeof x === 'string')
            .join(' — ');
        throw new Error(`Etherscan V2 API error: ${detail || 'unknown'}`);
    }

    if (!Array.isArray(data.result)) return [];

    return (data.result as any[]).map(r => ({
        address: r.address,
        topics: r.topics,
        data: r.data,
        blockNumber: typeof r.blockNumber === 'string' ? parseInt(r.blockNumber, 16) : r.blockNumber,
        transactionHash: r.transactionHash,
        logIndex: typeof r.logIndex === 'string' ? parseInt(r.logIndex, 16) : r.logIndex,
    }));
}

/**
 * Look up a verified contract's name and metadata from Etherscan.
 * Returns null if the contract isn't verified (source unavailable) or the
 * lookup fails. Never throws — verification is best-effort classifier data,
 * not blocking on find-factories output.
 *
 * Used by find-factories' classifier to turn `Factory_800b0526` into the
 * real contract name (e.g. `UniswapV2Factory`, `MeshSwapFactory`, `PairFactory`).
 * The name alone is often enough to identify a well-known DEX; combined with
 * compiler settings and license, it's a strong signal of legitimacy.
 */
export type ContractSourceInfo = {
    contractName: string;
    compilerVersion: string;
    optimizationUsed: boolean;
    runs: number;
    licenseType: string;
    proxy: boolean;
    implementation?: string;  // If proxy=true, the address of the implementation contract
};

export async function getContractSourceInfo(
    chainId: number,
    address: string,
    apiKey: string,
): Promise<ContractSourceInfo | null> {
    const url = new URL(V2_BASE);
    url.searchParams.set('chainid', String(chainId));
    url.searchParams.set('module', 'contract');
    url.searchParams.set('action', 'getsourcecode');
    url.searchParams.set('address', address);
    url.searchParams.set('apikey', apiKey);

    try {
        const res = await fetch(url.toString());
        if (!res.ok) return null;
        const data = await res.json() as any;
        if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) return null;

        const r = data.result[0];
        // Etherscan returns empty strings for unverified contracts. Distinguish
        // "verified but empty name" (rare) from "unverified" (common).
        if (!r.ContractName || r.ContractName === '') return null;

        return {
            contractName:     r.ContractName,
            compilerVersion:  r.CompilerVersion ?? '',
            optimizationUsed: r.OptimizationUsed === '1',
            runs:             Number(r.Runs) || 0,
            licenseType:      r.LicenseType ?? '',
            proxy:            r.Proxy === '1',
            implementation:   r.Implementation && r.Implementation !== '' ? r.Implementation : undefined,
        };
    } catch (err) {
        // Network errors, JSON parse errors, etc. — classifier data is
        // best-effort; return null and let the caller proceed without a name.
        return null;
    }
}

// -----------------------------------------------------------------------------
// Rate limiter for Etherscan API.
//
// Etherscan's stated free-tier rate limit is 5 calls/sec, but their enforcement
// counts bursts more tightly than a rolling 1-sec window suggests. Some
// accounts (or maybe some chains via V2) are limited to 3/sec. Pacing at
// exactly the stated limit trips their enforcer, so we default to a safer 2/sec.
//
// Configure via env: ETHERSCAN_RATE_MS=500 (min ms between calls). Set higher
// for slower/safer pacing, lower if you're on a paid tier with looser limits.
//
// ADAPTIVE: every time notifyRateLimit() is called (on a rate-limit rejection),
// the minimum interval is bumped up by 50%, permanently for the process
// lifetime. This means a sweep that keeps tripping the limit will converge to
// a pace that works, rather than retrying at the same failing pace forever.

let minIntervalMs = Number(process.env.ETHERSCAN_RATE_MS) || 500;
let lastCallAt = 0;

export async function rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < minIntervalMs) {
        await new Promise(res => setTimeout(res, minIntervalMs - elapsed));
    }
    lastCallAt = Date.now();
}

/**
 * Called by consumers when a rate-limit error was received despite our pacing.
 * Bumps the interval up 50% so future calls run slower. Caps at 5s to prevent
 * runaway slowdowns from other kinds of errors that got misclassified.
 */
export function notifyRateLimit(): void {
    const before = minIntervalMs;
    minIntervalMs = Math.min(5000, Math.floor(minIntervalMs * 1.5));
    if (minIntervalMs !== before) {
        console.log(`  [rateLimit] bumping interval ${before}ms → ${minIntervalMs}ms`);
    }
}
