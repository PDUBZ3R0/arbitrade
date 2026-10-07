// -----------------------------------------------------------------------------
// USD prices for venues that do not price in USD themselves.
//
// Morpho Blue prices each market as collateral-in-loan-token (1e36 scale), and
// a Comet prices in its own numeraire (USD for USDC markets, ETH for the WETH
// market). Liquidation PROFIT is always measured in the venue's own terms; USD
// is only needed for reports, the dust floor and the gas floor. It comes from
// the chain's Aave V3 oracle, which every Base / Arbitrum / Optimism deployment
// has and which covers the assets those markets lend (USDC, USDT, WETH, wstETH,
// cbBTC, …).
//
// An asset the oracle cannot price stays UNKNOWN (null) — never $0, because $0
// would make its positions look like dust and hide them. Next a recognised USD
// stablecoin symbol is priced at $1, which is right to within the precision
// any of these uses need; then the optional fallback (DexUsd: the deepest pool
// against a stablecoin in the scanner's DB) — which is what chains with no
// Aave at all (Robinhood) run on.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';
import { multicall3 } from '../util/multicall.ts';

const ORACLE_IFACE = new Interface([
    'function getAssetPrice(address asset) view returns (uint256)',
    'function BASE_CURRENCY_UNIT() view returns (uint256)',
]);
const ERC20 = new Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

const STABLE = /^(USDC|USDC\.e|USDbC|USDT|USD₮0|USDT0|DAI|USDS|LUSD|GHO|FRAX|crvUSD|PYUSD|USDe|sUSD)$/i;

export class UsdOracle {
    /** USD per whole token, scaled by `unit` (1e8). */
    private readonly prices = new Map<string, { price: bigint | null; at: number }>();
    private readonly meta = new Map<string, { symbol: string; decimals: number }>();
    readonly unit: bigint = 10n ** 8n;
    private readonly provider: JsonRpcProvider;
    private readonly oracle: string | null;
    private readonly ttlMs: number;
    /** Second opinion for what the oracle cannot price (DexUsd: the pool DB). USD per whole token. */
    private readonly fallback: ((token: string) => number | null) | null;

    constructor(provider: JsonRpcProvider, aaveOracle: string | null, ttlMs = 60_000, fallback: ((token: string) => number | null) | null = null) {
        this.provider = provider;
        this.oracle = aaveOracle;
        this.ttlMs = ttlMs;
        this.fallback = fallback;
    }

    /** Symbol + decimals, cached forever. */
    async tokenMeta(tokens: string[]): Promise<void> {
        const want = [...new Set(tokens.map(t => t.toLowerCase()))].filter(t => !this.meta.has(t));
        if (!want.length) return;
        const res = await multicall3(this.provider, want.flatMap(t => [
            { target: t, allowFailure: true, callData: ERC20.encodeFunctionData('symbol', []) },
            { target: t, allowFailure: true, callData: ERC20.encodeFunctionData('decimals', []) },
        ]));
        want.forEach((t, i) => {
            let symbol = '?', decimals = 18;
            try { if (res[2 * i]?.success) symbol = ERC20.decodeFunctionResult('symbol', res[2 * i].returnData)[0] as string; } catch { /* bytes32 symbol */ }
            try { if (res[2 * i + 1]?.success) decimals = Number(ERC20.decodeFunctionResult('decimals', res[2 * i + 1].returnData)[0]); } catch { /* keep 18 */ }
            this.meta.set(t, { symbol, decimals });
        });
    }

    symbol(token: string): string { return this.meta.get(token.toLowerCase())?.symbol ?? '?'; }
    decimals(token: string): number { return this.meta.get(token.toLowerCase())?.decimals ?? 18; }

    /** Refresh prices older than the TTL (or all, with force). */
    async refresh(tokens: string[], force = false): Promise<void> {
        await this.tokenMeta(tokens);
        const now = Date.now();
        const want = [...new Set(tokens.map(t => t.toLowerCase()))]
            .filter(t => force || !this.prices.has(t) || now - this.prices.get(t)!.at > this.ttlMs);
        if (!want.length) return;
        let res: Awaited<ReturnType<typeof multicall3>> = [];
        if (this.oracle) {
            try {
                res = await multicall3(this.provider, want.map(t => ({
                    target: this.oracle!, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData('getAssetPrice', [t]),
                })));
            } catch { res = []; }
        }
        want.forEach((t, i) => {
            let price: bigint | null = null;
            const r = res[i];
            if (r?.success && r.returnData !== '0x') {
                try { const p = ORACLE_IFACE.decodeFunctionResult('getAssetPrice', r.returnData)[0] as bigint; if (p > 0n) price = p; } catch { /* unpriced */ }
            }
            if (price == null && STABLE.test(this.symbol(t))) price = this.unit;
            if (price == null && this.fallback) {
                const usd = this.fallback(t);
                if (usd != null && Number.isFinite(usd) && usd > 0) price = BigInt(Math.round(usd * 1e8));
            }
            this.prices.set(t, { price, at: now });
        });
    }

    /** USD per whole token (x unit), or null if unknown. Call refresh() first. */
    price(token: string): bigint | null { return this.prices.get(token.toLowerCase())?.price ?? null; }

    /** USD value (x unit) of `amount` raw units of `token`, or null if unpriced. */
    value(token: string, amount: bigint): bigint | null {
        const p = this.price(token);
        if (p == null) return null;
        return amount * p / 10n ** BigInt(this.decimals(token));
    }

    /** Raw units of `token` worth `usd` (x unit), or null if unpriced. */
    units(token: string, usd: bigint): bigint | null {
        const p = this.price(token);
        if (p == null || p === 0n) return null;
        return usd * 10n ** BigInt(this.decimals(token)) / p;
    }
}
