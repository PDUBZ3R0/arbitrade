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
//
// SCOPE: classifyRevertData sees ONE pair. Verdicts that require comparing
// several pairs are not its job and it must not guess at them. In particular
// "can buy, cannot exit" — the honeypot signature — is only meaningful once
// every candidate pair has been tried, because a single failed exit is far more
// often a thin pool than a malicious token. probe.ts owns that conclusion; see
// the STAGE.SELL_SWAP comment below for what happens when this boundary is
// ignored.
// -----------------------------------------------------------------------------

import { Contract, Interface, id, type JsonRpcProvider } from 'ethers';
import { hasSelector, selectorOf } from './bytecode.ts';
import { detectProxy } from './proxy-detect.ts';

export const PROBE_ABI = [
    'function probe(address root, uint256 amount, address pair, uint16 feeBpsCap)',
    'function probeFrom(uint8 source, address lender, address root, uint256 amount, address pair, uint16 feeBpsCap)',
    'function probeCLFrom(uint8 source, address lender, address root, uint256 amount, address pool)',
    'error ProbeResult(uint256 buyRequested, uint256 buyReceived, uint256 sellSent, uint256 sellArrived, uint256 rootRequested, uint256 rootReceived)',
    'error ProbeFailed(uint8 stage, bytes reason)',
    'error NotPool()',
    'error UntrustedInitiator()',
    'error NoLender()',
    'error BadSource(uint8 source)',
    'error TokenNotInLender()',
];
const PROBE_IFACE = new Interface(PROBE_ABI);

/** Stage numbers — must match TokenProbe.sol. */
export const STAGE = { NO_CODE: 0, FUND_PAIR: 1, BUY_SWAP: 2, SELL_TRANSFER: 3, SELL_SWAP: 4, NO_CALLBACK: 5 } as const;

export type TokenVerdict = 'clean' | 'fee-on-transfer' | 'nonstandard' | 'honeypot' | 'dead';
export type PairVerdict = 'pair-restricted' | 'pair-rejects';
export type ProbeStatus = TokenVerdict | PairVerdict | 'error';

export const TOKEN_VERDICTS: readonly ProbeStatus[] = ['clean', 'fee-on-transfer', 'nonstandard', 'honeypot', 'dead'];
/** Token verdicts that make a token unusable for our routing. */
export const UNSAFE_TOKEN_VERDICTS: readonly TokenVerdict[] = ['fee-on-transfer', 'nonstandard', 'honeypot', 'dead'];

/**
 * Tokens that are nonstandard by construction, recorded without a probe trade.
 *
 * Polygon, 2026-11-01: POL at 0x…1010 is the chain's native-token system
 * contract (MRC20). Its transfer() returns false unless msg.value equals the
 * amount, so no pool can pay it out: three hot-loop simulations through
 * WPOL/POL on Uniswap V3 reverted "TF". The probe had it as untestable (no
 * root pair it could trade), which excludes nothing.
 */
export const KNOWN_NONSTANDARD: Record<number, ReadonlyArray<{ address: string; reason: string }>> = {
    137: [{
        address: '0x0000000000000000000000000000000000001010',
        reason: 'POL system contract (MRC20): transfer() needs msg.value == amount, so a pool cannot pay it out',
    }],
};

/** Record this chain's KNOWN_NONSTANDARD tokens as nonstandard; returns their addresses. */
export function markKnownNonstandard(
    db: { setTokenProbe(address: string, p: { status: string; buyTaxBps: number | null; sellTaxBps: number | null; reason: string; pair: string | null }): void },
    chainId: number,
): string[] {
    const known = KNOWN_NONSTANDARD[chainId] ?? [];
    for (const t of known) db.setTokenProbe(t.address, { status: 'nonstandard', buyTaxBps: null, sellTaxBps: null, reason: t.reason, pair: null });
    return known.map(t => t.address.toLowerCase());
}

// -----------------------------------------------------------------------------
// Checks a single small round trip cannot see. probe.ts runs them on every
// token the trade would have recorded clean.

/**
 * Elastic-supply (rebasing) entry points. A rebase changes every balance
 * without a transfer: a V2 pair resyncs, but a V3/Algebra pool cannot, and
 * after a negative rebase it owes more than it holds.
 *
 * Polygon, 2026-11-01: CVOL (0x9cd55255, an ElasticToken behind an EIP-1967
 * proxy, scalingFactor down to 0.037) round-tripped clean through its V2 pair,
 * while Algebra pool 0x324e0037 held 0.0000017 CVOL against ~7.5 of in-range
 * liquidity, so a USDC.e→CVOL hop reverted "TF".
 */
export const ELASTIC_SUPPLY_SIGNATURES = [
    'scalingFactor()',                 // YAM-style ElasticToken (CVI's CVOL)
    'rebase(uint256,int256)',          // Ampleforth uFragments
    'rebase(uint256,uint256)',         // Olympus sOHM
    'rebase(uint256,uint256,bool)',    // YAM
    'rebase(uint256,bool)',            // CVI ElasticToken
    'gonsForBalance(uint256)',         // Olympus forks
] as const;

/** The first elastic-supply signature in the token's code (or its EIP-1967 implementation's), or null. */
export async function elasticSupplySignature(provider: JsonRpcProvider, token: string): Promise<string | null> {
    const codes = [await provider.getCode(token)];
    const proxy = await detectProxy(provider, token);
    if (proxy.implementation) codes.push(await provider.getCode(proxy.implementation));
    for (const sig of ELASTIC_SUPPLY_SIGNATURES)
        if (codes.some(c => hasSelector(c, selectorOf(sig)))) return sig;
    return null;
}

const TRANSFER_IFACE = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

/**
 * Does the token refuse a large transfer out of `holder` that it allows at a
 * small size? Both are eth_calls "from" the holder (normally the pair the
 * probe traded through), so nothing is signed or moved. Returns the revert
 * reason for the large one, or null: no cap, or the small one already failed
 * (then the answer is something else and the probe's own verdict stands).
 *
 * Polygon, 2026-11-01: two "DESTRUCTION" tokens (0xc94aa2e1, 0xf1fba12e)
 * revert "ERR3" on any transfer over 0.6% of supply. The probe trades 0.5% of
 * the root reserve and passed them clean; the hot loop sizes hop 0 up to 15%
 * of it and four simulations reverted "UniswapV2: TRANSFER_FAILED".
 */
export async function transferCapReason(
    provider: JsonRpcProvider, token: string, holder: string, recipient: string, small: bigint, large: bigint,
): Promise<string | null> {
    const attempt = async (amount: bigint): Promise<string | null> => {
        try {
            const ret = await provider.call({ from: holder, to: token, data: TRANSFER_IFACE.encodeFunctionData('transfer', [recipient, amount]) });
            // No return data is fine (USDT-style); an explicit false is a refusal.
            return ret.length >= 66 && BigInt(ret.slice(0, 66)) === 0n ? 'transfer returned false' : null;
        } catch (err) {
            const data = extractRevertData(err);
            if (data) return decodeRevertReason(data);
            if ((err as any)?.code === 'CALL_EXCEPTION') return 'reverted without data';
            throw err;   // RPC trouble, not an answer
        }
    };
    if (small <= 0n || large <= small) return null;
    if (await attempt(small)) return null;
    return attempt(large);
}

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
                if (r === 'TF') return withStage('honeypot');             // the same from a V3 pool's TransferHelper
                // K-check or size problems: fee above cap, non-CP curve, or dust — inconclusive for the token.
                // 0xa932492f = K() custom error (seen on Sonic's Shadow pairs).
                if (/(^|[^A-Z])K($|[^A-Z])/.test(r) || r.includes('INSUFFICIENT') || reason.includes('0xa932492f')) return withStage('pair-rejects');
                return withStage('pair-restricted');
            case STAGE.SELL_TRANSFER:
                // token.transfer(pair) from this contract was refused. This one
                // IS about the token: we demonstrably hold the balance (the
                // probe measured buyReceived as its own balanceOf delta), and
                // the destination is an ordinary pair that accepted a transfer
                // on the buy leg moments earlier. A token that won't let us
                // send it onward is the textbook honeypot.
                // "exceeds balance": the token's balanceOf said we hold the
                // amount (that is how buyReceived was measured) and its own
                // transfer disagrees — a balanceOf that lies (rebasing,
                // reflection, locked balances) is nonstandard. Polygon,
                // 2026-10-14: this, and max-wallet messages ("Recipient's
                // balance would exceed…") that the old BALANCE match also
                // caught, were filed as "error (retry next run)" — retried
                // forever, never excluded.
                if (/EXCEEDS BALANCE|INSUFFICIENT BALANCE|BALANCE TOO LOW/.test(r)) return withStage('nonstandard');
                return withStage('honeypot');
            case STAGE.SELL_SWAP:
                // pair.swap() on the way back — NOT automatically a honeypot.
                // This is the same ambiguity the buy leg resolves above, for the
                // same reasons, so it gets the same triage.
                //
                // Note what the probe has already done by this point: it sized
                // the requested output from `arrived`, the pair's MEASURED
                // balance increase, so a transfer tax is priced in and cannot
                // cause this revert. What's left are all facts about the pair:
                //   - real fee above feeBpsCap — we asked for more than the
                //     K-check allows
                //   - non-constant-product curve (stable / Solidly)
                //   - dust reserves, or `requested` rounding down to 0
                //
                // Calling those a honeypot labelled 82,501 of Polygon's 162,648
                // tokens (51%) as honeypots and cut the enumerable pair set from
                // 192,377 to 97,449 — the long tail of thin pools, not malice.
                //
                // "Could buy but can never sell" is still a honeypot, but that
                // is a CROSS-PAIR conclusion and cannot be drawn here, where
                // exactly one pair is in view. probe.ts draws it after trying
                // every candidate pair for the token.
                if (r.includes('TRANSFER')) return withStage('honeypot');
                if (/(^|[^A-Z])K($|[^A-Z])/.test(r) || r.includes('INSUFFICIENT') || reason.includes('0xa932492f')) return withStage('pair-rejects');
                return withStage('pair-restricted');
            default:
                return withStage('error');
        }
    }
    if (parsed.name === 'NoLender' || parsed.name === 'BadSource' || parsed.name === 'TokenNotInLender')
        return { status: 'error', ...none, reason: `lender config: ${parsed.name} — check flashloan in the chain conf` };
    // An arithmetic Panic inside the probe is a balance that went DOWN across
    // a transfer we received (received = after - before underflows): the token
    // takes back more than it gave. That is a fact about the token, not an
    // RPC hiccup to retry.
    if (parsed.name === 'Panic') {
        const code = (parsed.args[0] as bigint);
        if (code === 0x11n) return { status: 'nonstandard', ...none, reason: 'a balance fell across a transfer to the probe (arithmetic underflow measuring it) — breaks V2 swap math' };
    }
    return { status: 'error', ...none, reason: `unexpected probe error ${parsed.name}${parsed.name === 'Panic' ? ` 0x${(parsed.args[0] as bigint).toString(16)}` : ''}` };
}

// -----------------------------------------------------------------------------

/** Where the probe borrows from: FlashArbExecutor's SOURCE id and the lender contract. */
export type ProbeLender = { source: number; lender: string };

const PROBE_FROM_SELECTOR = id('probeFrom(uint8,address,address,uint256,address,uint16)').slice(2, 10);

/**
 * Whether the TokenProbe deployed at `address` has probeFrom (any lender) or
 * only the original Aave-only probe(). Read from the dispatcher (PUSH4 selector).
 */
export async function probeSupportsLenders(provider: JsonRpcProvider, address: string): Promise<boolean> {
    const code = (await provider.getCode(address)).toLowerCase();
    return hasSelector(code, PROBE_FROM_SELECTOR);
}

// -----------------------------------------------------------------------------

export async function probePair(
    provider: JsonRpcProvider,
    probeAddress: string,
    root: string,
    pair: string,
    amount: bigint,
    feeBpsCap = 200,
    /** Borrow through probeFrom from this lender; omitted → probe() via the constructor's Aave pool. */
    via?: ProbeLender,
): Promise<ProbeOutcome> {
    const probe = new Contract(probeAddress, PROBE_ABI, provider);
    try {
        if (via) await probe.probeFrom.staticCall(via.source, via.lender, root, amount, pair, feeBpsCap);
        else await probe.probe.staticCall(root, amount, pair, feeBpsCap);
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

// -----------------------------------------------------------------------------

const PROBE_CL_SELECTOR = id('probeCLFrom(uint8,address,address,uint256,address)').slice(2, 10);

/** Whether the TokenProbe at `address` can probe concentrated-liquidity pools (probeCLFrom). */
export async function probeSupportsCL(provider: JsonRpcProvider, address: string): Promise<boolean> {
    return hasSelector((await provider.getCode(address)).toLowerCase(), PROBE_CL_SELECTOR);
}

/**
 * The round trip through a V3 / CL / Algebra pool (TokenProbe.probeCLFrom): exact-input
 * swaps each way, no fee cap. Such a pool checks its balance after the swap callback,
 * so a token taxed on the way in can't be sold there at all: a sell tax is a honeypot
 * for anyone holding it from this pool, whatever its size.
 */
export async function probeCLPool(provider: JsonRpcProvider, probeAddress: string, root: string, pool: string, amount: bigint, via: ProbeLender): Promise<ProbeOutcome> {
    const probe = new Contract(probeAddress, PROBE_ABI, provider);
    let r: ProbeOutcome;
    try {
        await probe.probeCLFrom.staticCall(via.source, via.lender, root, amount, pool);
        return { status: 'error', buyTaxBps: null, sellTaxBps: null, stage: null, reason: 'probe call returned without reverting — wrong address?' };
    } catch (err) {
        const data = extractRevertData(err);
        if (!data) {
            const msg = String((err as any)?.shortMessage ?? (err as any)?.message ?? err).slice(0, 160);
            return { status: 'error', buyTaxBps: null, sellTaxBps: null, stage: null, reason: `rpc: ${msg}` };
        }
        r = classifyRevertData(data);
    }
    // 'pair-restricted' is the V2 reading of an unrecognised swap revert: a
    // pair that admits only its own router. A V3/CL pool has no caller gate;
    // its unrecognised reverts are size and variant trouble. Polygon,
    // 2026-11-01: the first CL sweep filed 13 canonical Uniswap V3 pools as
    // restricted on "AS" (the amount rounded to 0) and empty reverts, and
    // offered to blacklist Sonic's NineMM V3 factory on 5 empty reverts.
    if (r.status === 'pair-restricted') return { ...r, status: 'pair-rejects' };
    if (r.status === 'fee-on-transfer' && (r.sellTaxBps ?? 0) > 0)
        return { ...r, status: 'honeypot', reason: `sell tax ${((r.sellTaxBps ?? 0) / 100).toFixed(2)}%: a concentrated-liquidity pool can't take a taxed sell` };
    return r;
}
