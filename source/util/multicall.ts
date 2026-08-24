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
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface, type Result } from 'ethers';

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
): Promise<Multicall3Result[]> {
    if (calls.length === 0) return [];

    const data = iface.encodeFunctionData('aggregate3', [
        calls.map(c => [c.target, c.allowFailure, c.callData]),
    ]);

    const raw = await provider.call({ to: MULTICALL3_ADDRESS, data });
    const decoded = iface.decodeFunctionResult('aggregate3', raw)[0] as Result;

    return (decoded as unknown as Array<[boolean, string]>).map(([success, returnData]) => ({
        success,
        returnData,
    }));
}
