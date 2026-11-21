// -----------------------------------------------------------------------------
// Client for our own envio indexer (../hyperindex/ronin): Hasura REST
// endpoints over every pool-creation event on every chain it indexes.
//
//   chain/{id}/processed                 how far the indexer has got
//   chain/{id}/factories?block=N         emitters whose FIRST pool is at >= N
//   chain/{id}/factory/{addr}?block=N&limit=L
//                                        that factory's summary, plus its pools
//                                        at >= N, one array per event family
//
// Setup (.env): ENVIO_REST_URL=http://localhost:8080/api/rest and
// ENVIO_REST_SECRET=<HASURA_GRAPHQL_ADMIN_SECRET from the indexer's .env>.
//
// Everything it says is only complete up to `processed`, NOT the chain head:
// callers must record that block as how far they got, never the RPC head, or
// the pools between the two are skipped for good.
// -----------------------------------------------------------------------------

import type { EventLayout } from './pool-events.ts';

/** The indexer's family names, and the creation-event layout each one is. */
export const LAYOUT_BY_FAMILY: Record<string, EventLayout> = {
    v2: 'v2', solidly: 'solidly', velodrome: 'velodrome', v3: 'v3',
    aerodrome: 'aerodrome',   // tick-spacing PoolCreated: Aerodrome CL, Slipstream, Shadow
    algebra: 'algebra',
};

/** One array per event table in the factory endpoint's response, by layout. */
const TABLES: Array<{ table: string; layout: EventLayout; poolField: 'pool' | 'pair' }> = [
    { table: 'UniswapV2Factory_PairCreated',  layout: 'v2',        poolField: 'pair' },
    { table: 'Solidly_PairCreated',           layout: 'solidly',   poolField: 'pair' },
    { table: 'Velodrome_PoolCreated',         layout: 'velodrome', poolField: 'pool' },
    { table: 'UniswapV3Factory_PoolCreated',  layout: 'v3',        poolField: 'pool' },
    { table: 'Aerodrome_PoolCreated',         layout: 'aerodrome', poolField: 'pool' },
    { table: 'Algebra_Pool',                  layout: 'algebra',   poolField: 'pool' },
];

export type EnvioFactory = {
    factory: string;            // lowercase
    family: string;
    layout: EventLayout | null; // null for a family this client doesn't know
    pairCount: number;
    firstBlock: number;
    lastBlock: number;
};

export type EnvioPool = {
    layout: EventLayout;
    pool: string;
    token0: string;
    token1: string;
    blockNumber: number;
    stable: boolean | null;
    feePips: number | null;
    tickSpacing: number | null;
};

/** Hasura stringifies numeric columns (HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES). */
function num(v: unknown): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function poolOf(t: typeof TABLES[number], r: any): EnvioPool {
    return {
        layout: t.layout, pool: String(r[t.poolField]).toLowerCase(),
        token0: String(r.token0).toLowerCase(), token1: String(r.token1).toLowerCase(),
        blockNumber: num(r.blockNumber) ?? 0,
        stable: typeof r.stable === 'boolean' ? r.stable : null,
        feePips: num(r.fee),
        tickSpacing: num(r.tickSpacing),
    };
}

export type EnvioSample = { layout: EventLayout; firstBlock: number; pools: EnvioPool[] };

/** Blocks back from a factory's last pool that count as recent. */
const RECENT_BLOCKS = 200_000;

export class EnvioRest {
    readonly base: string;
    private readonly secret: string | undefined;

    constructor(base: string, secret?: string) {
        this.base = base.replace(/\/+$/, '');
        this.secret = secret;
    }

    /** From ENVIO_REST_URL / ENVIO_REST_SECRET, or null when the URL isn't set. */
    static fromEnv(): EnvioRest | null {
        const url = process.env.ENVIO_REST_URL;
        return url ? new EnvioRest(url, process.env.ENVIO_REST_SECRET || undefined) : null;
    }

    private async get(path: string, query: Record<string, number> = {}): Promise<any> {
        const qs = Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&');
        const url = `${this.base}/${path}${qs ? `?${qs}` : ''}`;
        const res = await fetch(url, {
            headers: this.secret ? { 'x-hasura-admin-secret': this.secret } : {},
            signal: AbortSignal.timeout(120_000),
        });
        const body = await res.text();
        // A wrong secret is refused even where no secret at all would be let in
        // (Hasura's unauthorized role), so say which setting it is.
        const hint = res.status === 401 && this.secret ? ' — ENVIO_REST_SECRET must equal the running Hasura\'s HASURA_GRAPHQL_ADMIN_SECRET, or be left empty if its public role is enough' : '';
        if (!res.ok) throw new Error(`envio ${path}: HTTP ${res.status} ${body.slice(0, 160)}${hint}`);
        return JSON.parse(body);
    }

    /**
     * The last block the indexer has fully processed for this chain. Throws when
     * it doesn't index the chain or hasn't started on it (it reports -1 then):
     * an empty answer from it would otherwise read as "no pools".
     */
    async processed(chainId: number): Promise<number> {
        const rows = (await this.get(`chain/${chainId}/processed`)).chain_metadata ?? [];
        const block = num(rows[0]?.latest_processed_block);
        if (block === null) throw new Error(`envio does not index chain ${chainId} (add it to the indexer's config.yaml)`);
        if (block < 0) throw new Error(`envio has not processed any block of chain ${chainId} yet`);
        return block;
    }

    /** Every factory whose first pool is at or after `since` (0: all of them). */
    async factories(chainId: number, since = 0): Promise<EnvioFactory[]> {
        const rows = (await this.get(`chain/${chainId}/factories`, since > 0 ? { block: since } : {})).Factory ?? [];
        return rows.map((r: any) => ({
            factory: String(r.factory).toLowerCase(),
            family: String(r.family),
            layout: LAYOUT_BY_FAMILY[r.family] ?? null,
            pairCount: num(r.pairCount) ?? 0,
            firstBlock: num(r.firstBlock) ?? 0,
            lastBlock: num(r.lastBlock) ?? 0,
        }));
    }

    /**
     * A handful of a factory's pools, newest first, then its earliest, which are
     * usually its main pairs. Null when the indexer has no pools for it. This
     * is what the verifiers should read: asking the chain for recent logs gave
     * a different answer per run on BSC, down to "no events" for a factory with
     * 19,313 pools, because public endpoints time out or drop those ranges.
     */
    async samplePools(chainId: number, factory: string, limit = 5): Promise<EnvioSample | null> {
        const page = async (block: number) => {
            const body = await this.get(`chain/${chainId}/factory/${factory.toLowerCase()}`, { block, limit });
            return { meta: body.Factory?.[0], pools: TABLES.flatMap(t => (body[t.table] ?? []).map((r: any) => poolOf(t, r))) as EnvioPool[] };
        };
        const earliest = await page(0);
        if (!earliest.pools.length) return null;
        const last = num(earliest.meta?.lastBlock) ?? 0;
        const recent = last > RECENT_BLOCKS ? await page(last - RECENT_BLOCKS) : { pools: [] as EnvioPool[] };
        const byAddr = new Map([...recent.pools.reverse(), ...earliest.pools].map(p => [p.pool, p]));
        return { layout: earliest.pools[0].layout, firstBlock: num(earliest.meta?.firstBlock) ?? earliest.pools[0].blockNumber, pools: [...byAddr.values()] };
    }

    /**
     * Every pool `factory` created at or after `since`, across all six event
     * tables, fetched `limit` rows per table per request.
     *
     * Pages by block: the next request starts at the last block a full page
     * reached (block >= is inclusive, so that block's pools come back again and
     * are deduplicated by address). That only holds if the endpoint returns
     * rows in block order — a full page that isn't is an error, not a guess,
     * because paging past an unordered page skips pools.
     */
    async pools(chainId: number, factory: string, since = 0, limit = 10_000,
                onPage?: (got: number, block: number) => void): Promise<EnvioPool[]> {
        const byAddr = new Map<string, EnvioPool>();
        let block = since;
        for (;;) {
            const page = await this.get(`chain/${chainId}/factory/${factory.toLowerCase()}`, { block, limit });
            let next = Infinity;
            for (const t of TABLES) {
                const rows: any[] = page[t.table] ?? [];
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    const bn = num(r.blockNumber) ?? 0;
                    if (rows.length >= limit && i > 0 && bn < (num(rows[i - 1].blockNumber) ?? 0)) {
                        throw new Error(`envio ${t.table} for ${factory}: a full page (${limit}) is not in block order, so paging ` +
                            `would skip pools — add order_by: {blockNumber: asc} to that query in the indexer's REST endpoint`);
                    }
                    const pool = poolOf(t, r);
                    byAddr.set(pool.pool, pool);
                }
                if (rows.length >= limit) next = Math.min(next, num(rows[rows.length - 1].blockNumber) ?? 0);
            }
            onPage?.(byAddr.size, next);
            if (next === Infinity) break;
            if (next <= block) {
                throw new Error(`envio: ${factory} has ${limit}+ pools in block ${block} alone — raise the page limit`);
            }
            block = next;
        }
        return [...byAddr.values()];
    }
}
