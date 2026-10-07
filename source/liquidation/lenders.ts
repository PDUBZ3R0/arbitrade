// -----------------------------------------------------------------------------
// Flash-loan lender book: where to borrow a token for a liquidation, cheapest
// first.
//
//   1. config     conf/<chain>.json5 flashloan.tokens[].provider = balancer-v2 /
//                 morpho for this token — the operator's explicit choice wins
//   2. Morpho     the chain's Morpho Blue singleton: flash loans are FREE and
//                 lend the singleton's whole balance of the token
//   3. Balancer   the V2 Vault (same address on every chain it is on): free
//                 unless governance has set a flash-loan fee (it is 0 today)
//   4. Aave V3    the Pool: 0.05% premium (v3.3 default), always present
//
// A lender is used only if it is actually deployed here (code at the address)
// and holds at least the amount. The simulation that follows is the real
// check — a lender whose fee is not what we assumed shows up as lower profit.
// -----------------------------------------------------------------------------

import { Interface, getAddress, type JsonRpcProvider } from 'ethers';
import { multicall3 } from '../util/multicall.ts';
import { flashTermsFor, BALANCER_V2_VAULT, type ChainConfig } from '../util/config.ts';
import { MORPHO_BLUE } from './morpho.ts';

const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)']);

export type Lender = { source: 0 | 1 | 3; lender: string; label: string; feeBps: number };

export class LenderBook {
    private readonly provider: JsonRpcProvider;
    private readonly cfg: Pick<ChainConfig, 'flashloan' | 'chain'>;
    private readonly aavePool: string | null;
    private readonly candidates: Array<{ source: 1 | 3; lender: string; label: string }>;
    private readonly hasCode = new Map<string, boolean>();

    constructor(provider: JsonRpcProvider, cfg: Pick<ChainConfig, 'flashloan' | 'chain'>, aavePool: string | null, extra: { morpho?: string; balancer?: string } = {}) {
        this.provider = provider;
        this.cfg = cfg;
        this.aavePool = aavePool ? getAddress(aavePool) : null;
        const morpho = extra.morpho ?? MORPHO_BLUE[Number(cfg.chain.id)]?.address;
        this.candidates = [
            ...(morpho ? [{ source: 3 as const, lender: getAddress(morpho), label: 'Morpho (free)' }] : []),
            { source: 1 as const, lender: getAddress(extra.balancer ?? BALANCER_V2_VAULT), label: 'Balancer V2 (free)' },
        ];
    }

    private async deployed(addr: string): Promise<boolean> {
        if (!this.hasCode.has(addr)) {
            const code = await this.provider.getCode(addr).catch(() => '0x');
            this.hasCode.set(addr, code !== '0x');
        }
        return this.hasCode.get(addr)!;
    }

    /** Cheapest lender with code here and `amount` of `token` on hand; Aave as the fallback. */
    async pick(token: string, amount: bigint): Promise<Lender | null> {
        const t = flashTermsFor(this.cfg, token);
        if (t && (t.provider === 'balancer-v2' || t.provider === 'morpho')) {
            return { source: t.provider === 'morpho' ? 3 : 1, lender: getAddress(t.lender), label: `${t.provider} (config)`, feeBps: Math.round(t.premium * 1e4) };
        }
        const live: typeof this.candidates = [];
        for (const c of this.candidates) if (await this.deployed(c.lender)) live.push(c);
        if (live.length) {
            const res = await multicall3(this.provider, live.map(c => ({ target: token, allowFailure: true, callData: ERC20.encodeFunctionData('balanceOf', [c.lender]) })));
            for (let i = 0; i < live.length; i++) {
                const r = res[i];
                if (r?.success && r.returnData !== '0x' && (ERC20.decodeFunctionResult('balanceOf', r.returnData)[0] as bigint) >= amount) {
                    return { ...live[i], feeBps: 0 };
                }
            }
        }
        return this.aavePool ? { source: 0, lender: this.aavePool, label: 'Aave V3 (0.05%)', feeBps: 5 } : null;
    }
}
