// -----------------------------------------------------------------------------
// Token / pair safety probe — client side for contracts/TokenProbe.sol.
//
// TokenProbe flash-borrows a root token, buys the other side of a pair,
// sells it back, and ALWAYS reverts with either ProbeResult (measured
// amounts) or ProbeFailed(stage, reason). We eth_call it, pull the revert
// data out of the error, and classify.
//
// Verdicts are split by what they're ABOUT:
//   token-level:  clean | fee-on-transfer | nonstandard | honeypot | dead
//   pair-level:   pair-restricted (swap rejects outsiders — Panaromaswap-style)
//                 pair-rejects    (K / insufficient-* — fee above our cap,
//                                  curve mismatch, or dust; says nothing
//                                  about the token)
//   neither:      error (couldn't evaluate — RPC failure, unknown revert)
// A pair-level verdict must never poison a token's verdict, so callers retry
// a token through a different pair when they get one.
// -----------------------------------------------------------------------------

import { Contract, Interface, type JsonRpcProvider } from 'ethers';

export const PROBE_ABI = [
    'function probe(address root, uint256 amount, address pair, uint16 feeBpsCap)',
    'error ProbeResult(uint256 buyRequested, uint256 buyReceived, uint256 sellSent, uint256 sellArrived, uint256 rootRequested, uint256 rootReceived)',
    'error ProbeFailed(uint8 stage, bytes reason)',
    'error NotPool()',
    'error UntrustedInitiator()',
];
const PROBE_IFACE = new Interface(PROBE_ABI);

/** Stage numbers — must match TokenProbe.sol. */
export const STAGE = { NO_CODE: 0, FUND_PAIR: 1, BUY_SWAP: 2, SELL_TRANSFER: 3, SELL_SWAP: 4 } as const;

export type TokenVerdict = 'clean' | 'fee-on-transfer' | 'nonstandard' | 'honeypot' | 'dead';
export type PairVerdict = 'pair-restricted' | 'pair-rejects';
export type ProbeStatus = TokenVerdict | PairVerdict | 'error';

export const TOKEN_VERDICTS: readonly ProbeStatus[] = ['clean', 'fee-on-transfer', 'nonstandard', 'honeypot', 'dead'];
/** Token verdicts that make a token unusable for our routing. */
export const UNSAFE_TOKEN_VERDICTS: readonly TokenVerdict[] = ['fee-on-transfer', 'nonstandard', 'honeypot', 'dead'];

export type ProbeOutcome = {
    status: ProbeStatus;
    buyTaxBps: number | null;
    sellTaxBps: number | null;
    stage: number | null;
    reason: string;
};

/** Amounts within this many raw units count as equal (share-based tokens round by 1-2 wei). */
const DUST_UNITS = 2n;

// -----------------------------------------------------------------------------
// Revert-data helpers

const ERROR_STRING_SELECTOR = '0x08c379a0'; // Error(string)
const PANIC_SELECTOR = '0x4e487b71';        // Panic(uint256)
const GENERIC_IFACE = new Interface(['error Error(string)', 'error Panic(uint256)']);

/** Human-readable form of arbitrary revert data (Error(string), Panic, or a custom-error selector). */
export function decodeRevertReason(data: string | null | undefined): string {
    if (!data || data === '0x') return 'empty revert';
    const sel = data.slice(0, 10).toLowerCase();
    try {
        if (sel === ERROR_STRING_SELECTOR) return String(GENERIC_IFACE.decodeErrorResult('Error', data)[0]);
        if (sel === PANIC_SELECTOR) return `panic 0x${(GENERIC_IFACE.decodeErrorResult('Panic', data)[0] as bigint).toString(16)}`;
    } catch { /* fall through */ }
    // Probe-reported string reasons (e.g. "token has no code") arrive as raw UTF-8 bytes.
    if (/^0x([0-9a-f]{2})+$/i.test(data) && data.length < 200) {
        const text = Buffer.from(data.slice(2), 'hex').toString('utf8');
        if (/^[\x20-\x7e]+$/.test(text)) return text;
    }
    return `custom error ${sel}`;
}

/** Pull revert data out of whatever shape the provider/ethers error has. */
export function extractRevertData(err: any): string | null {
    const candidates = [err?.data, err?.info?.error?.data, err?.error?.data, err?.error?.error?.data, err?.revert?.data];
    for (const c of candidates) {
        if (typeof c === 'string' && c.startsWith('0x')) return c;
        if (c && typeof c.data === 'string' && c.data.startsWith('0x')) return c.data;
    }
    return null;
}

// -----------------------------------------------------------------------------
// Classification (pure — exported for testing)

const taxBps = (sent: bigint, arrived: bigint): number =>
    sent > 0n && sent - arrived > DUST_UNITS ? Number(((sent - arrived) * 10_000n) / sent) : 0;

export function classifyRevertData(data: string | null): ProbeOutcome {
    const none = { buyTaxBps: null, sellTaxBps: null, stage: null };
    if (!data) return { status: 'error', ...none, reason: 'no revert data (RPC did not return it?)' };

    let parsed;
    try { parsed = PROBE_IFACE.parseError(data); } catch { parsed = null; }
    if (!parsed) return { status: 'error', ...none, reason: `unexpected revert: ${decodeRevertReason(data)}` };

    if (parsed.name === 'ProbeResult') {
        const [buyRequested, buyReceived, sellSent, sellArrived] = parsed.args as unknown as bigint[];
        const inflated = buyReceived > buyRequested + DUST_UNITS || sellArrived > sellSent + DUST_UNITS;
        const buyTax = taxBps(buyRequested, buyReceived);
        const sellTax = taxBps(sellSent, sellArrived);
        if (inflated) return { status: 'nonstandard', buyTaxBps: buyTax, sellTaxBps: sellTax, stage: null,
            reason: 'more tokens arrived than were sent (reflection/rebasing) — breaks V2 swap math' };
        if (buyTax > 0 || sellTax > 0) return { status: 'fee-on-transfer', buyTaxBps: buyTax, sellTaxBps: sellTax, stage: null,
            reason: `transfer tax: buy ${(buyTax / 100).toFixed(2)}%, sell ${(sellTax / 100).toFixed(2)}%` };
        return { status: 'clean', buyTaxBps: 0, sellTaxBps: 0, stage: null, reason: 'round trip ok' };
    }

    if (parsed.name === 'ProbeFailed') {
        const stage = Number(parsed.args[0]);
        const reason = decodeRevertReason(parsed.args[1] as string);
        const r = reason.toUpperCase();
        const withStage = (status: ProbeStatus) => ({ status, buyTaxBps: null, sellTaxBps: null, stage, reason });
        switch (stage) {
            case STAGE.NO_CODE:
                return withStage('dead');
            case STAGE.FUND_PAIR:
                return withStage('error'); // root token transfer failed — a config problem, not a verdict
            case STAGE.BUY_SWAP:
                if (r.includes('TRANSFER')) return withStage('honeypot'); // token refused to be sent to a contract
                // K-check or size problems: fee above cap, non-CP curve, or dust — inconclusive for the token.
                // 0xa932492f = K() custom error (seen on Sonic's Shadow pairs).
                if (/(^|[^A-Z])K($|[^A-Z])/.test(r) || r.includes('INSUFFICIENT') || reason.includes('0xa932492f')) return withStage('pair-rejects');
                return withStage('pair-restricted');
            case STAGE.SELL_TRANSFER:
            case STAGE.SELL_SWAP:
                return withStage('honeypot'); // bought fine, couldn't exit
            default:
                return withStage('error');
        }
    }
    return { status: 'error', ...none, reason: `unexpected probe error ${parsed.name}` };
}

// -----------------------------------------------------------------------------

export async function probePair(
    provider: JsonRpcProvider,
    probeAddress: string,
    root: string,
    pair: string,
    amount: bigint,
    feeBpsCap = 200,
): Promise<ProbeOutcome> {
    const probe = new Contract(probeAddress, PROBE_ABI, provider);
    try {
        await probe.probe.staticCall(root, amount, pair, feeBpsCap);
        // Unreachable if TokenProbe is deployed correctly — it always reverts.
        return { status: 'error', buyTaxBps: null, sellTaxBps: null, stage: null, reason: 'probe call returned without reverting — wrong address?' };
    } catch (err) {
        const data = extractRevertData(err);
        if (!data) {
            const msg = String((err as any)?.shortMessage ?? (err as any)?.message ?? err).slice(0, 160);
            return { status: 'error', buyTaxBps: null, sellTaxBps: null, stage: null, reason: `rpc: ${msg}` };
        }
        return classifyRevertData(data);
    }
}
