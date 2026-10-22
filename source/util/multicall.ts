// -----------------------------------------------------------------------------
// Multicall3 helper.
//
// Multicall3 is deployed at the same address on virtually every EVM chain:
//   0xcA11bde05977b3631167028862bE2a173976CA11
//
// Its aggregate3 function packs N arbitrary eth_calls into one, saving orders
// of magnitude on RPC round-trips when reading a small piece of state from
// many contracts (e.g. per-pair fee lookups across thousands of Solidly pairs).
//
// Docs: https://github.com/mds1/multicall
//
// NOT EVERY CHAIN HAS IT. Hydration (222222) has no Multicall3, nor Multicall2
// or Maker's Multicall, so every Aave read (market, prices, health) failed
// there and its Aave fork could not be watched. Where the address has no code,
// multicall3() runs each call as its own eth_call (same results, same block
// tag; NOT atomic when no block is pinned) — slower, but it works.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface, isCallException, type Result } from 'ethers';

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
];

const iface = new Interface(MULTICALL3_ABI);

export type Multicall3Call = {
    target: string;
    /** If false, revert the whole aggregate on this call's failure. Prefer true. */
    allowFailure: boolean;
    /** Hex-encoded calldata (selector + abi-encoded args) */
    callData: string;
};

export type Multicall3Result = {
    success: boolean;
    returnData: string;  // hex, empty string on failure with allowFailure
};

/**
 * Execute a batch of calls via Multicall3. Returns raw results — decoding
 * per-call is the caller's responsibility.
 *
 * The whole batch is one eth_call, so all returned data is fetched at a
 * single block. That means the reads are atomically consistent.
 */
export async function multicall3(
    provider: JsonRpcProvider,
    calls: Multicall3Call[],
    /** Read at this block instead of latest — to line up with another read. */
    blockTag?: number | string,
): Promise<Multicall3Result[]> {
    if (calls.length === 0) return [];

    if (!(await hasMulticall3(provider))) return callEach(provider, calls, blockTag);

    const data = iface.encodeFunctionData('aggregate3', [
        calls.map(c => [c.target, c.allowFailure, c.callData]),
    ]);

    const raw = await provider.call({ to: MULTICALL3_ADDRESS, data, blockTag });
    const decoded = iface.decodeFunctionResult('aggregate3', raw)[0] as Result;

    return (decoded as unknown as Array<[boolean, string]>).map(([success, returnData]) => ({
        success,
        returnData,
    }));
}

/** Per provider: is Multicall3 deployed? A failed lookup is not cached (asked again next time). */
const deployed = new WeakMap<JsonRpcProvider, Promise<boolean>>();
function hasMulticall3(provider: JsonRpcProvider): Promise<boolean> {
    let p = deployed.get(provider);
    if (!p) {
        p = provider.getCode(MULTICALL3_ADDRESS).then(code => {
            if (code === '0x') console.log(`  [i] no Multicall3 on this chain — batched reads fall back to one eth_call per call`);
            return code !== '0x';
        });
        p.catch(() => deployed.delete(provider));
        deployed.set(provider, p);
    }
    return p.catch(() => true);   // lookup failed: try Multicall3, as before
}

const EACH_CONCURRENCY = 8;

/** aggregate3 without the contract: a revert is that call's failure (or the batch's, unless allowFailure); anything else throws. */
async function callEach(provider: JsonRpcProvider, calls: Multicall3Call[], blockTag?: number | string): Promise<Multicall3Result[]> {
    const out: Multicall3Result[] = new Array(calls.length);
    let next = 0;
    const worker = async () => {
        while (next < calls.length) {
            const i = next++, c = calls[i];
            try { out[i] = { success: true, returnData: await provider.call({ to: c.target, data: c.callData, blockTag }) }; }
            catch (e) {
                if (!isCallException(e) || !c.allowFailure) throw e;
                out[i] = { success: false, returnData: e.data ?? '0x' };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(EACH_CONCURRENCY, calls.length) }, worker));
    return out;
}
