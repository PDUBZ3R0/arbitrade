// -----------------------------------------------------------------------------
// YoBatches client.
//
// YoBatches is our on-chain batch reader (contracts/YoBatches.sol). Its main
// function reads token balances for many pairs in one call, which we treat as
// the pair's reserves. Compatible with V2, Solidly volatile pools, and any
// AMM where tokens are held directly in the pair contract.
//
// It uses defensive wrapping (wbalance/cbalance) so tokens with broken
// balanceOf implementations return 0 rather than reverting the whole batch.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface } from 'ethers';

const YOBATCHES_ABI = [
    'function getReservesByPairs((address pair, address token0, address token1)[] args) view returns ((address pair, address token0, uint256 reserves0, address token1, uint256 reserves1)[])',
];

// The Solidity struct is address[3] not a tuple, but ethers accepts either.
// Using the tuple form gives us named fields in the decoded response.
const iface = new Interface([
    'function getReservesByPairs(address[3][] args) view returns ((address pair, address token0, uint256 reserves0, address token1, uint256 reserves1)[])',
]);

export type ReservesRow = {
    pair: string;
    token0: string;
    reserves0: bigint;
    token1: string;
    reserves1: bigint;
};

/**
 * Read reserves for a batch of pairs. Order is preserved.
 *
 * `triples` is an array of [pair, token0, token1] tuples. The token ordering
 * doesn't matter to YoBatches — it just does balanceOf(token, pair) for both —
 * but the reserves in the response follow the order you passed.
 */
export async function getReservesByPairs(
    provider: JsonRpcProvider,
    yobatchesAddress: string,
    triples: Array<[string, string, string]>,
): Promise<ReservesRow[]> {
    if (triples.length === 0) return [];

    const data = iface.encodeFunctionData('getReservesByPairs', [triples]);
    const raw = await provider.call({ to: yobatchesAddress, data });
    const decoded = iface.decodeFunctionResult('getReservesByPairs', raw)[0] as any[];

    return decoded.map(entry => ({
        pair:      entry[0] as string,
        token0:    entry[1] as string,
        reserves0: BigInt(entry[2]),
        token1:    entry[3] as string,
        reserves1: BigInt(entry[4]),
    }));
}
