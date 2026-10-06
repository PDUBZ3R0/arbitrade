// -----------------------------------------------------------------------------
// Seed the borrower watchlist from Aave's official V3 subgraph.
//
// The watcher needs the CURRENT borrower set, not the event history that
// produced it. Aave's subgraph already maintains `User.borrowedReservesCount`,
// so one paginated query returns every account with open debt — ~100 queries
// for a 100k-borrower market, against The Graph's free 100k queries/month.
// No HyperSync token, no getLogs rate limits.
//
// TRUST MODEL: the subgraph only proposes accounts. Every one is then read
// on-chain with getUserAccountData before any tier is assigned, so a stale or
// buggy subgraph can only (a) add an account that turns out idle, or (b) miss
// one, which the RPC tail adds on its next Borrow/Repay/etc. To close (b) for
// accounts that are quiet, the tail starts at the subgraph's own indexed block
// (`_meta.block.number`), and every page is pinned to that block so the set is
// a consistent snapshot rather than a moving target across pages.
//
// The subgraph is also checked to be indexing OUR pool: Aave runs separate
// subgraphs per market (core / Lido / EtherFi on Ethereum), and seeding the
// Prime market's users into the Core watchlist would be silent garbage.
//
// Setup: free API key at https://thegraph.com/studio/apikeys -> GRAPH_API_KEY
// in .env. Subgraph ids below are from github.com/aave/protocol-subgraphs;
// override per chain with liquidation.subgraph in conf/<chain>.json5 (an id,
// or a full https URL for a self-hosted / non-gateway endpoint).
// -----------------------------------------------------------------------------

import type { LiqDB } from './watchlist-db.ts';

/** Aave V3 subgraph ids on The Graph's decentralized network, by chain label. */
export const AAVE_V3_SUBGRAPHS: Record<string, string> = {
    ethereum:  'Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g',   // Core market
    polygon:   'Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211',
    avalanche: '2h9woxy8RTjHu1HJsCEnmzpPHFArU33avmUh4f71JpVn',
    arbitrum:  'DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B',
    optimism:  'DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb',
    gnosis:    'HtcDaL8L8iZ2KQNNS44EBVmLruzxuNAz1RkBYdui1QUT',
    bsc:       '7Jk85XgkV1MQ7u56hD8rr65rfASbayJXopugWkUoBMnZ',
    base:      'GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF',
    scroll:    '74JwenoHZb2aAYVGCCSdPWzi9mm745dyHyQQVoZ7Sbub',
    zksync:    'ENYSc8G3WvrbhWH8UZHrqPWYRcuyCaNmaTmoVp7uzabM',
    linea:     'Gz2kjnmRV1fQj3R8cssoZa5y9VTanhrDo4Mh7nWW1wHa',
    sonic:     'FQcacc4ZJaQVS9euWb76nvpSq2GxavBnUM6DU6tmspbi',
    celo:      'GAVWZzGwQ6d6QbFojyFWxpZ2GB9Rf5hZgGyJHCEry8kn',
    soneium:   '5waxmqS3rkRtZPoV2mL5RCToupVxVbTd7hjicxMGebYm',
    ink:       '6AY9ccNwMwd3G27zp9vUKWCi9ugvNS6gkh5EEBY2xnPC',
    megaeth:   'DnfLSdosqrcZ8pb8G2rL954SdRB8Pk4jjkgjtfwfx7cY',
    xlayer:    '3sfF6x49emXFzMov1q7AvRVCkVZpSTZxuKeLDXZY53sE',
    monad:     'H36q2dDvJHQP1A2ayzL1XpjoB5aKuMZcB8iLa7nR3X3D',
};

export const GRAPH_GATEWAY = 'https://gateway.thegraph.com/api';

/**
 * Endpoint for a chain, or null when none can be built. `override` is
 * liquidation.subgraph: an id (needs the key) or a full URL (used as-is).
 */
export function resolveSubgraphUrl(chainLabel: string, override: string | undefined, apiKey: string | undefined): string | null {
    if (override && /^https?:\/\//i.test(override)) return override;
    const id = override ?? AAVE_V3_SUBGRAPHS[chainLabel];
    if (!id || !apiKey) return null;
    return `${GRAPH_GATEWAY}/${apiKey}/subgraphs/id/${id}`;
}

/** Redact the API key for logs. */
export const redactUrl = (url: string): string => url.replace(/(\/api\/)[^/]+(\/subgraphs)/, '$1***$2');

type Fetch = typeof fetch;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** POST a GraphQL query; retries 429/5xx/network errors, throws on GraphQL errors. */
export async function gql<T>(url: string, query: string, variables: Record<string, unknown>, fetchImpl: Fetch = fetch, retries = 4): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
        let res: Response;
        try {
            res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query, variables }),
            });
        } catch (err) { lastErr = err; continue; }
        if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const text = await res.text();
        if (!res.ok) throw new Error(`subgraph HTTP ${res.status}: ${text.slice(0, 200)}`);
        let body: { data?: T; errors?: Array<{ message: string }> };
        try { body = JSON.parse(text); } catch { throw new Error(`subgraph returned non-JSON: ${text.slice(0, 200)}`); }
        if (body.errors?.length) {
            const msg = body.errors.map(e => e.message).join('; ');
            // Gateway indexer hiccups surface as GraphQL errors; worth a retry. Auth / bad-query errors are not.
            if (/indexer|timeout|unavailable|try again/i.test(msg) && attempt < retries) { lastErr = new Error(msg); continue; }
            throw new Error(`subgraph error: ${msg.slice(0, 300)}`);
        }
        if (!body.data) throw new Error('subgraph returned no data');
        return body.data;
    }
    throw new Error(`subgraph unreachable after ${retries + 1} attempts: ${(lastErr as Error)?.message ?? lastErr}`);
}

const META_QUERY = `{
  _meta { block { number } hasIndexingErrors }
  pools(first: 100) { id pool }
}`;

const USERS_QUERY = `query ($b: Int!, $last: String!, $n: Int!) {
  users(block: { number: $b }, first: $n, orderBy: id, orderDirection: asc,
        where: { borrowedReservesCount_gt: 0, id_gt: $last }) { id }
}`;

export type SeedResult = { users: number; block: number; pages: number; hasIndexingErrors: boolean };

/**
 * Fetch every account the subgraph says has open debt, at one pinned block,
 * insert them into `db`, and set progress to that block so the RPC tail
 * continues from block+1. Pagination is by `id_gt`, not `skip` (The Graph
 * caps skip at 5000).
 */
export async function seedFromSubgraph(
    url: string,
    db: LiqDB,
    opts: { pageSize?: number; log?: (s: string) => void; fetch?: Fetch } = {},
): Promise<SeedResult> {
    const pageSize = opts.pageSize ?? 1000;
    const log = opts.log ?? (() => {});
    const f = opts.fetch ?? fetch;

    const meta = await gql<{
        _meta: { block: { number: number }; hasIndexingErrors: boolean };
        pools: Array<{ id: string; pool: string | null }>;
    }>(url, META_QUERY, {}, f);
    const block = Number(meta._meta.block.number);
    const pools = meta.pools.map(p => (p.pool ?? '').toLowerCase()).filter(Boolean);
    if (pools.length && !pools.includes(db.pool)) {
        throw new Error(`subgraph indexes pool(s) ${pools.join(', ')}, not ${db.pool} — wrong market or wrong chain. ` +
            `Set liquidation.subgraph in the chain config to the right id.`);
    }
    if (!pools.length) log(`  [!] subgraph exposes no pool address; cannot confirm it indexes ${db.pool}`);
    if (meta._meta.hasIndexingErrors) log(`  [!] subgraph reports indexing errors — it may be stuck; the RPC tail from block ${block} covers what it missed`);

    const users: string[] = [];
    let last = '', pages = 0;
    while (true) {
        const d = await gql<{ users: Array<{ id: string }> }>(url, USERS_QUERY, { b: block, last, n: pageSize }, f);
        pages++;
        for (const u of d.users) {
            const id = u.id.toLowerCase();
            if (/^0x[0-9a-f]{40}$/.test(id)) users.push(id);
        }
        log(`\r  [subgraph] ${users.length.toLocaleString()} borrowers (${pages} page${pages === 1 ? '' : 's'})`);
        if (d.users.length < pageSize) break;
        last = d.users[d.users.length - 1].id;
    }
    log('\n');

    // Same path as a Borrow event: inserts, keeps any existing rows, and
    // advances progress (MAX) to the snapshot block in one transaction.
    db.applyEvents(users.map(account => ({ account, isBorrow: true, blockNumber: block })), block);
    return { users: users.length, block, pages, hasIndexingErrors: meta._meta.hasIndexingErrors };
}
