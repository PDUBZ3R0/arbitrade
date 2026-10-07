// -----------------------------------------------------------------------------
// USD prices from the scanner's own pool DB (db/<chain>.sqlite), for chains
// with no Aave oracle (Robinhood) and for assets the oracle does not list.
//
//   token/stable  pair: price = stable reserve / token reserve
//   token/native  pair: price = that ratio x the native token's own stable price
//
// Among V2-kind, non-stable-curve pairs, the one holding the most of the
// priced token wins, and a pair only counts when its stablecoin (or native)
// side holds at least MIN_SIDE_USD — a $50 pool quoting a token at $10,000 is
// exactly what this must ignore.
//
// Reserves are as fresh as the last `yarn reserves` / hot-loop write, which is
// plenty for what USD is used for here (gas floor, dust floor, reports). It is
// never used to size or approve a liquidation: profit is always measured
// on-chain in the debt asset by simulation.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import Database from 'better-sqlite3';

const STABLE = /^(USDC|USDC\.e|USDbC|USDT|USD₮0|USDT0|DAI|USDS|LUSD|GHO|FRAX|crvUSD|PYUSD|USDe|USDG|AUSD|USDCe|USDt)$/i;
const MIN_SIDE_USD = 10_000;

type Row = { token0: string; token1: string; reserves0: string; reserves1: string };
type Tok = { symbol: string | null; decimals: number | null };

export class DexUsd {
    private readonly db: Database.Database | null;
    private readonly native: string | null;
    private readonly cache = new Map<string, { usd: number | null; at: number }>();
    private readonly toks = new Map<string, Tok>();
    private stables: string[] | null = null;
    private tokensOk: boolean | null = null;
    private readonly ttlMs: number;

    constructor(dbFile: string, nativeToken: string | null, ttlMs = 60_000) {
        this.db = fs.existsSync(dbFile) ? new Database(dbFile, { readonly: true, fileMustExist: true }) : null;
        this.native = nativeToken?.toLowerCase() ?? null;
        this.ttlMs = ttlMs;
    }

    get available(): boolean { return this.db != null; }
    close(): void { this.db?.close(); }

    private hasTokens(): boolean {
        if (this.tokensOk == null) this.tokensOk = this.db!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tokens'").get() != null;
        return this.tokensOk;
    }

    private tok(addr: string): Tok {
        let t = this.toks.get(addr);
        if (!t) {
            t = (this.hasTokens() ? this.db!.prepare('SELECT symbol, decimals FROM tokens WHERE address = ?').get(addr) as Tok | undefined : undefined) ?? { symbol: null, decimals: null };
            this.toks.set(addr, t);
        }
        return t;
    }

    /** Every token in the DB whose symbol is a USD stablecoin. */
    private stableSet(): string[] {
        if (!this.stables) {
            if (!this.hasTokens()) return (this.stables = []);
            const rows = this.db!.prepare('SELECT address, symbol FROM tokens WHERE decimals IS NOT NULL').iterate() as Iterable<{ address: string; symbol: string | null }>;
            this.stables = [];
            for (const r of rows) if (r.symbol && STABLE.test(r.symbol)) this.stables.push(r.address.toLowerCase());
        }
        return this.stables;
    }

    /** Pairs between `token` and any of `others` (V2-kind, not stable-curve). */
    private pairs(token: string, others: string[]): Row[] {
        if (!others.length) return [];
        const out: Row[] = [];
        for (let i = 0; i < others.length; i += 500) {
            const part = others.slice(i, i + 500);
            const q = part.map(() => '?').join(',');
            out.push(...this.db!.prepare(`
                SELECT p.token0, p.token1, r.reserves0, r.reserves1 FROM pairs p JOIN reserves r ON r.pair = p.address
                WHERE p.kind = 'v2' AND COALESCE(p.stable, 0) = 0
                  AND ((p.token0 = ? AND p.token1 IN (${q})) OR (p.token1 = ? AND p.token0 IN (${q})))`).all(token, ...part, token, ...part) as Row[]);
        }
        return out;
    }

    /** Deepest quote of `token` against `others`, each worth usdOf(other). */
    private best(token: string, others: string[], usdOf: (other: string) => number): number | null {
        const me = this.tok(token);
        if (me.decimals == null) return null;
        let bestUsd: number | null = null, bestDepth = 0;
        for (const r of this.pairs(token, others)) {
            const mine0 = r.token0 === token;
            const other = mine0 ? r.token1 : r.token0;
            const o = this.tok(other);
            if (o.decimals == null) continue;
            const rMe = Number(mine0 ? r.reserves0 : r.reserves1) / 10 ** me.decimals;
            const rOther = Number(mine0 ? r.reserves1 : r.reserves0) / 10 ** o.decimals;
            const sideUsd = rOther * usdOf(other);
            // Ranked by how much of the PRICED token the pool holds, not by its
            // stablecoin side: anyone can mint a fake "USDC" and pair a mountain
            // of it against WETH, but outbidding the real pool's WETH costs real WETH.
            if (!(rMe > 0) || sideUsd < MIN_SIDE_USD || rMe <= bestDepth) continue;
            bestDepth = rMe;
            bestUsd = sideUsd / rMe;
        }
        return bestUsd;
    }

    /** USD per whole token, or null. */
    priceUsd(token: string): number | null {
        if (!this.db) return null;
        const t = token.toLowerCase();
        const hit = this.cache.get(t);
        if (hit && Date.now() - hit.at < this.ttlMs) return hit.usd;
        let usd: number | null;
        const sym = this.tok(t).symbol;
        if (sym && STABLE.test(sym)) usd = 1;
        else {
            usd = this.best(t, this.stableSet(), () => 1);
            if (usd == null && this.native && t !== this.native) {
                const nativeUsd = this.priceUsd(this.native);
                if (nativeUsd != null) usd = this.best(t, [this.native], () => nativeUsd);
            }
        }
        this.cache.set(t, { usd, at: Date.now() });
        return usd;
    }
}
