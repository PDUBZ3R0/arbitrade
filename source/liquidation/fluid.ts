// -----------------------------------------------------------------------------
// Fluid vault liquidations. Fluid is tick-based: a liquidation is not aimed at
// one borrower but at a vault — you repay some of the vault's debt token and
// receive its collateral token at a discount, and the vault settles whichever
// positions crossed their tick internally. So Fluid is a per-vault POLL (like
// buying Comet reserves), not a borrower watchlist.
//
// The FluidVaultLiquidationResolver does the heavy lifting: getAllVaultsSwap()
// returns, per T1 vault with something liquidatable right now, a Swap with
//   path.tokenIn  = debt token to repay      data.inAmt  = how much
//   path.tokenOut = collateral token out     data.outAmt = how much
//   data.withAbsorb, data.ratio (outAmt/inAmt x 1e27)
// which is exactly the executor's liquidate() call. colPerUnitDebt (the min
// collateral per unit debt, 1e18) is outAmt/inAmt less a slippage haircut, as
// the resolver's own getSwapTx computes it.
//
// Covers VaultT1 (single collateral / single debt); the resolver's
// getAllVaultsSwap enumerates only those. T2/T3/T4 smart/dex vaults are out of
// scope here. Native-token legs (0xEeee…) are skipped — the redeem/receive side
// would be native coin the HopEngine can't route.
//
// Resolver address (same on every chain it is on): Instadapp fluid-contracts
// deployments/<chain>/VaultLiquidationResolver.json.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';
import type { UsdOracle } from './usd.ts';

/** FluidVaultLiquidationResolver per chain id (one address, many chains). */
export const FLUID_LIQ_RESOLVER: Record<number, string> = {
    1:     '0xd8d1a39b1Fe519113b6D8e1E82Dc92aedaD40948',
    42161: '0xd8d1a39b1Fe519113b6D8e1E82Dc92aedaD40948',
    8453:  '0xd8d1a39b1Fe519113b6D8e1E82Dc92aedaD40948',
    137:   '0xd8d1a39b1Fe519113b6D8e1E82Dc92aedaD40948',
    9745:  '0xd8d1a39b1Fe519113b6D8e1E82Dc92aedaD40948',
};

export const RESOLVER_IFACE = new Interface([
    'function getAllVaultsSwap() returns (((address protocol, address tokenIn, address tokenOut) path, (uint256 inAmt, uint256 outAmt, bool withAbsorb, uint256 ratio) data)[] swaps)',
    'function getVaultsSwap(address[] vaults) returns (((address protocol, address tokenIn, address tokenOut) path, (uint256 inAmt, uint256 outAmt, bool withAbsorb, uint256 ratio) data)[] swaps)',
]);
export const FLUID_VAULT_IFACE = new Interface([
    'function liquidate(uint256 debtAmt, uint256 colPerUnitDebt, address to, bool absorb) payable returns (uint256 actualDebtAmt, uint256 actualColAmt)',
]);

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const RATIO_SCALE = 10n ** 27n;

export type FluidOpportunity = {
    vault: string;
    debt: string;         // tokenIn (repay)
    collateral: string;   // tokenOut (received)
    inAmt: bigint;
    outAmt: bigint;
    withAbsorb: boolean;
    /** outAmt/inAmt x 1e27; > 1e27 means more collateral out than debt in (before gas/swap). */
    ratio: bigint;
};

export class FluidScanner {
    readonly resolver: string;
    private readonly provider: JsonRpcProvider;
    readonly usd: UsdOracle;

    constructor(provider: JsonRpcProvider, resolver: string, usd: UsdOracle) {
        this.provider = provider;
        this.resolver = resolver.toLowerCase();
        this.usd = usd;
    }

    /** Every T1 vault with a liquidation available right now (resolver-simulated). ERC20 legs only. */
    async opportunities(): Promise<FluidOpportunity[]> {
        // getAllVaultsSwap is non-view (it simulates), so read it with eth_call.
        let raw: string;
        try { raw = await this.provider.call({ to: this.resolver, data: RESOLVER_IFACE.encodeFunctionData('getAllVaultsSwap', []) }); }
        catch { return []; }
        if (!raw || raw === '0x') return [];
        const [swaps] = RESOLVER_IFACE.decodeFunctionResult('getAllVaultsSwap', raw) as unknown as [Array<{ path: [string, string, string]; data: [bigint, bigint, boolean, bigint] }>];
        const out: FluidOpportunity[] = [];
        for (const s of swaps) {
            const [vault, tokenIn, tokenOut] = [s.path[0].toLowerCase(), s.path[1].toLowerCase(), s.path[2].toLowerCase()];
            const [inAmt, outAmt, withAbsorb, ratio] = s.data;
            if (inAmt === 0n || outAmt === 0n) continue;
            if (tokenIn === NATIVE || tokenOut === NATIVE) continue;   // can't route a native leg
            out.push({ vault, debt: tokenIn, collateral: tokenOut, inAmt, outAmt, withAbsorb, ratio });
        }
        return out;
    }

    /** min collateral per unit debt (1e18), the resolver's getSwapTx formula, with a slippage haircut (bps). */
    colPerUnitDebt(o: FluidOpportunity, slippageBps = 50): bigint {
        return (o.outAmt * 10n ** 18n / o.inAmt) * BigInt(10_000 - slippageBps) / 10_000n;
    }

    /** USD value of the collateral an opportunity pays out, or null if unpriced. */
    async payoutUsd(o: FluidOpportunity): Promise<number | null> {
        await this.usd.refresh([o.collateral, o.debt]);
        const outV = this.usd.value(o.collateral, o.outAmt);
        const inV = this.usd.value(o.debt, o.inAmt);
        if (outV == null || inV == null) return null;
        return Number(outV - inV) / Number(this.usd.unit);   // gross edge before gas/swap fees
    }

    gross(o: FluidOpportunity): bigint { return o.ratio > RATIO_SCALE ? o.ratio - RATIO_SCALE : 0n; }
}
