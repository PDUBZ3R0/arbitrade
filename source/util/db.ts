// -----------------------------------------------------------------------------
// SQLite database layer.
//
// Schema:
//
//   factories  — one row per known DEX factory, per chain
//     (we also store name/type/fee here for reference; source of truth is config)
//
//   pairs      — one row per pool: V2-family pairs (PairCreated) and, with
//                kind = 'v3', concentrated-liquidity pools (PoolCreated)
//     UNIQUE(factory, address) prevents duplicate inserts on rescan
//     Indexed by token0, token1, and (token0, token1) for triangle enumeration
//
//   reserves   — rolling snapshot of pair reserves (one row per pair, upserted)
//     reserves0/1 stored as TEXT because uint112 can exceed JS Number precision
//     when tokens have 18 decimals and pool holds > ~9M tokens
//
//   scan_progress — last block scanned per factory, so we can resume
//
//   pool_state / pool_ticks — concentrated-liquidity (kind = 'v3') pool state
//     as read by YoBatches2.getV3State: price, tick, in-range liquidity, fee,
//     spacing, and the initialized ticks inside the fetched window. A v3 pool
//     ALSO gets a reserves row holding its virtual reserves (L/sqrtP, L*sqrtP),
//     so everything that only needs a price or a depth signal — enumeration,
//     dust filters, numeraire pricing — works unchanged. Anything that needs
//     to SIZE a trade must use pool_state instead: virtual reserves are only
//     valid up to the next initialized tick.
//
// -----------------------------------------------------------------------------

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS factories (
        address     TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'v2',
        -- Nullable: v2/v3 have a flat fee (0.003 default); v2fee/solidly can
        -- either declare a flat fee (opt-in flat-fee mode) OR leave it NULL
        -- to signal per-pair lookup via feeFunction. NULL means "see the
        -- factory config's feeTarget/feeFunction/feeDivisor and pairs.fee".
        fee         REAL,
        deployBlock INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairs (
        address     TEXT NOT NULL,
        factory     TEXT NOT NULL,
        token0      TEXT NOT NULL,
        token1      TEXT NOT NULL,
        blockNumber INTEGER NOT NULL,
        -- Nullable per-pair overrides for Solidly-family factories where
        -- fee varies per pair (looked up via factory.pairFee(pair)) and
        -- pairs have distinct stable vs volatile curves.
        -- NULL = use factory-level defaults; only V2/V3 assumptions apply.
        fee         REAL,
        stable      INTEGER,  -- 0/1, NULL for pure V2 (no stable/volatile distinction)
        -- 'v2' = tokens held in the pair, priced from balances (V2, v2fee, solidly).
        -- 'v3' = concentrated liquidity, priced from slot0/liquidity/ticks via
        --        YoBatches2.getV3State. Anything reading reserves as balances
        --        or calling pair.swap(amount0Out, amount1Out, ...) must filter
        --        on kind = 'v2'.
        kind        TEXT NOT NULL DEFAULT 'v2',
        tickSpacing INTEGER,  -- v3 only
        -- Concentrated-liquidity variant, for kind='v3' pools. NULL/'univ3' =
        -- Uniswap-V3-shaped (slot0/ticks, read by YoBatches.getV3State).
        -- 'algebra-v1' / 'algebra-integral' = Algebra, read via globalState and
        -- the version's tick storage (YoBatches.getAlgebraState). Decides which
        -- state reader the reserves pass uses.
        cl_variant  TEXT,
        PRIMARY KEY (factory, address)
    );

    -- Indexes for triangle enumeration: "give me pairs containing token X"
    CREATE INDEX IF NOT EXISTS idx_pairs_token0 ON pairs(token0);
    CREATE INDEX IF NOT EXISTS idx_pairs_token1 ON pairs(token1);
    CREATE INDEX IF NOT EXISTS idx_pairs_tokens ON pairs(token0, token1);
    CREATE INDEX IF NOT EXISTS idx_pairs_factory ON pairs(factory);

    CREATE TABLE IF NOT EXISTS reserves (
        pair        TEXT PRIMARY KEY,
        reserves0   TEXT NOT NULL,
        reserves1   TEXT NOT NULL,
        blockNumber INTEGER NOT NULL,
        updatedAt   INTEGER NOT NULL   -- unix timestamp
    );

    CREATE INDEX IF NOT EXISTS idx_reserves_block ON reserves(blockNumber);

    CREATE TABLE IF NOT EXISTS pool_state (
        pool          TEXT PRIMARY KEY,
        sqrtPriceX96  TEXT NOT NULL,      -- uint160 as decimal string
        tick          INTEGER NOT NULL,
        liquidity     TEXT NOT NULL,      -- uint128 as decimal string
        fee           INTEGER NOT NULL,   -- pips (3000 = 0.3%), from pool.fee()
        tickSpacing   INTEGER NOT NULL,
        windowLow     INTEGER NOT NULL,   -- pool_ticks is complete for ticks in
        windowHigh    INTEGER NOT NULL,   --   [windowLow, windowHigh], nothing beyond
        blockNumber   INTEGER NOT NULL,
        updatedAt     INTEGER NOT NULL
    );

    -- Root-pool token balances read by the v3 reachability prefilter
    -- (reserves/v3-state.ts). Cached so a re-run does not re-read millions
    -- of mostly-dead root pools: entries younger than the prefilter TTL are
    -- reused. Raw balances, not a verdict, so changing the threshold needs no
    -- re-read.
    CREATE TABLE IF NOT EXISTS root_checks (
        pool       TEXT PRIMARY KEY,
        bal0       TEXT NOT NULL,
        bal1       TEXT NOT NULL,
        checkedAt  INTEGER NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS pool_ticks (
        pool          TEXT NOT NULL,
        tick          INTEGER NOT NULL,
        liquidityNet  TEXT NOT NULL,      -- int128 as decimal string
        PRIMARY KEY (pool, tick)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS scan_progress (
        factory      TEXT PRIMARY KEY,
        lastBlock    INTEGER NOT NULL,
        updatedAt    INTEGER NOT NULL
    );

    -- Triangles: cached enumeration of arb cycles rooted at flash-loanable tokens.
    -- Regenerated by \`yarn triangles <chain>\` after significant pair changes.
    -- The evaluator (piece 5) reads this table + reserves to score each triangle.
    CREATE TABLE IF NOT EXISTS triangles (
        id           INTEGER PRIMARY KEY,
        root_token   TEXT NOT NULL,   -- the flash-loan token; cycle starts and ends here
        hop_count    INTEGER NOT NULL,  -- 2 or 3

        -- Tokens in cycle order (a → b → c → a)
        -- For hop_count=2, token_c = token_a = root_token
        token_a      TEXT NOT NULL,
        token_b      TEXT NOT NULL,
        token_c      TEXT NOT NULL,

        -- Pairs used at each hop
        pair_ab      TEXT NOT NULL,
        pair_bc      TEXT NOT NULL,
        pair_ca      TEXT NOT NULL,

        -- Factories used at each hop (reporting/filtering; one factory can still
        -- supply several hops — V3 fee tiers, Solidly stable+volatile)
        factory_ab   TEXT NOT NULL,
        factory_bc   TEXT NOT NULL,
        factory_ca   TEXT NOT NULL,

        -- Canonical dedup key: rotation-invariant string built from sorted pair addresses.
        -- Uniqueness enforced via idx_triangles_canonical below (an explicit,
        -- named index), NOT an inline UNIQUE column constraint — inline UNIQUE
        -- creates an internal sqlite_autoindex that can't be dropped/rebuilt by
        -- name, which blocks the bulk-insert optimization (drop indexes, insert
        -- millions of rows, rebuild indexes in one sorted pass) used for large
        -- chains. See insertTriangles() and migrateTrianglesCanonicalIndex().
        canonical    TEXT NOT NULL,

        createdAt    INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_triangles_canonical ON triangles(canonical);
    CREATE INDEX IF NOT EXISTS idx_triangles_root ON triangles(root_token);
    CREATE INDEX IF NOT EXISTS idx_triangles_hop  ON triangles(hop_count);
    CREATE INDEX IF NOT EXISTS idx_triangles_pair_ab ON triangles(pair_ab);
    CREATE INDEX IF NOT EXISTS idx_triangles_pair_bc ON triangles(pair_bc);
    CREATE INDEX IF NOT EXISTS idx_triangles_pair_ca ON triangles(pair_ca);

    -- Token metadata (symbol / name / decimals) fetched from the chain.
    -- Populated by \`yarn tokens <chain>\`. Read-side JOINed by any UI or log
    -- output that wants to show token addresses as human-readable symbols.
    --
    -- \`fetchStatus\`: 'ok' when the on-chain fetch succeeded;
    --                 'reverted' when the token's symbol()/decimals() reverted
    --                            (non-standard ERC20; symbol/decimals will be NULL);
    --                 'nocode' when the address has no bytecode (long-tail
    --                          scam contracts get self-destructed);
    --                 'pending' when we've seen the address but not yet fetched.
    CREATE TABLE IF NOT EXISTS tokens (
        address      TEXT PRIMARY KEY,
        symbol       TEXT,
        name         TEXT,
        decimals     INTEGER,
        fetchStatus  TEXT NOT NULL,   -- 'ok' | 'reverted' | 'nocode' | 'pending'
        fetchedAt    INTEGER,          -- unix ts
        discoveredAt INTEGER NOT NULL  -- unix ts of first-seen
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens(symbol);
    CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(fetchStatus);
`;

/**
 * Schema migration: for existing databases that don't have the fee/stable
 * columns on pairs, add them. ALTER TABLE ADD COLUMN is idempotent-safe if
 * we check first.
 */
function migratePairsColumns(db: import('better-sqlite3').Database): void {
    const cols = db.prepare("PRAGMA table_info(pairs)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has('fee')) {
        db.exec('ALTER TABLE pairs ADD COLUMN fee REAL');
    }
    if (!names.has('stable')) {
        db.exec('ALTER TABLE pairs ADD COLUMN stable INTEGER');
    }
    if (!names.has('kind')) {
        // Every pre-existing row came from a PairCreated scan, so 'v2' is right.
        db.exec("ALTER TABLE pairs ADD COLUMN kind TEXT NOT NULL DEFAULT 'v2'");
    }
    if (!names.has('tickSpacing')) {
        db.exec('ALTER TABLE pairs ADD COLUMN tickSpacing INTEGER');
    }
    if (!names.has('cl_variant')) {
        db.exec('ALTER TABLE pairs ADD COLUMN cl_variant TEXT');
    }
}

/**
 * Schema migration: safety-probe columns (see contracts/TokenProbe.sol and
 * source/probe.ts). Idempotent ALTER TABLE ADD COLUMN, same pattern as
 * migratePairsColumns.
 *   tokens.probeStatus  clean | fee-on-transfer | nonstandard | honeypot | dead | untestable | NULL (never probed)
 *   pairs.probeStatus   ok | pair-restricted | pair-rejects | NULL (never probed)
 */
function migrateProbeColumns(db: import('better-sqlite3').Database): void {
    const tokenCols = new Set((db.prepare("PRAGMA table_info(tokens)").all() as Array<{ name: string }>).map(c => c.name));
    for (const [col, type] of [['probeStatus', 'TEXT'], ['buyTaxBps', 'INTEGER'], ['sellTaxBps', 'INTEGER'],
                               ['probeReason', 'TEXT'], ['probedAt', 'INTEGER'], ['probedPair', 'TEXT']] as const) {
        if (!tokenCols.has(col)) db.exec(`ALTER TABLE tokens ADD COLUMN ${col} ${type}`);
    }
    const pairCols = new Set((db.prepare("PRAGMA table_info(pairs)").all() as Array<{ name: string }>).map(c => c.name));
    for (const [col, type] of [['probeStatus', 'TEXT'], ['probeReason', 'TEXT'], ['probedAt', 'INTEGER']] as const) {
        if (!pairCols.has(col)) db.exec(`ALTER TABLE pairs ADD COLUMN ${col} ${type}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tokens_probe ON tokens(probeStatus)`);
}

/** Token probe verdicts that make a token unusable for routing (kept in sync with token-probe.ts UNSAFE_TOKEN_VERDICTS). */
export const UNSAFE_TOKEN_STATUSES = ['fee-on-transfer', 'nonstandard', 'honeypot', 'dead'] as const;
/** Pair probe verdicts that make a pair unusable for routing. */
export const UNSAFE_PAIR_STATUSES = ['pair-restricted'] as const;

/**
 * Schema migration: factories.fee was originally NOT NULL DEFAULT 0.003, but
 * v2fee/solidly factories legitimately have NULL fees (per-pair mode). SQLite
 * can't ALTER COLUMN DROP NOT NULL, so we swap the table: create a new one
 * with the correct schema, copy data over, drop old, rename.
 *
 * Idempotent: checks PRAGMA table_info's `notnull` flag first. If the fee
 * column is already nullable, does nothing.
 */
function migrateFactoriesFeeNullable(db: import('better-sqlite3').Database): void {
    const cols = db.prepare("PRAGMA table_info(factories)").all() as Array<{ name: string; notnull: number }>;
    const feeCol = cols.find(c => c.name === 'fee');
    // notnull is 0 for nullable, non-zero for NOT NULL. If missing or already nullable, skip.
    if (!feeCol || feeCol.notnull === 0) return;

    db.exec(`
        BEGIN;
        CREATE TABLE factories_new (
            address     TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL DEFAULT 'v2',
            fee         REAL,
            deployBlock INTEGER NOT NULL
        );
        INSERT INTO factories_new (address, name, type, fee, deployBlock)
            SELECT address, name, type, fee, deployBlock FROM factories;
        DROP TABLE factories;
        ALTER TABLE factories_new RENAME TO factories;
        COMMIT;
    `);
}

/**
 * Schema migration: triangles.canonical was originally an inline UNIQUE
 * column constraint, which SQLite backs with an internal sqlite_autoindex_*
 * that can't be dropped/recreated by name. That blocks the bulk-insert
 * optimization (drop all indexes before a huge insert, rebuild them in one
 * sorted pass after — far faster than maintaining 6 B-trees incrementally
 * across millions of individual row inserts, which is what made triangle
 * persistence slow on large chains like Polygon).
 *
 * Migrates by table-swap (SQLite can't drop an inline constraint via ALTER),
 * same pattern as migrateFactoriesFeeNullable. Idempotent: detects the old
 * inline UNIQUE via PRAGMA index_list's autoindex naming and no-ops if
 * already migrated (or if the table doesn't exist yet — SCHEMA above already
 * creates the new shape for a fresh DB).
 */
function migrateTrianglesCanonicalIndex(db: import('better-sqlite3').Database): void {
    const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='triangles'`
    ).get();
    if (!tableExists) return;

    const indexes = db.prepare(`PRAGMA index_list(triangles)`).all() as Array<{ name: string; unique: number; origin: string }>;
    const hasInlineUnique = indexes.some(idx => idx.origin === 'u' && idx.name.startsWith('sqlite_autoindex_triangles_'));
    if (!hasInlineUnique) return;

    db.exec(`
        BEGIN;
        CREATE TABLE triangles_new (
            id           INTEGER PRIMARY KEY,
            root_token   TEXT NOT NULL,
            hop_count    INTEGER NOT NULL,
            token_a      TEXT NOT NULL,
            token_b      TEXT NOT NULL,
            token_c      TEXT NOT NULL,
            pair_ab      TEXT NOT NULL,
            pair_bc      TEXT NOT NULL,
            pair_ca      TEXT NOT NULL,
            factory_ab   TEXT NOT NULL,
            factory_bc   TEXT NOT NULL,
            factory_ca   TEXT NOT NULL,
            canonical    TEXT NOT NULL,
            createdAt    INTEGER NOT NULL
        );
        INSERT INTO triangles_new SELECT
            id, root_token, hop_count, token_a, token_b, token_c,
            pair_ab, pair_bc, pair_ca, factory_ab, factory_bc, factory_ca,
            canonical, createdAt
        FROM triangles;
        DROP TABLE triangles;
        ALTER TABLE triangles_new RENAME TO triangles;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_triangles_canonical ON triangles(canonical);
        CREATE INDEX IF NOT EXISTS idx_triangles_root ON triangles(root_token);
        CREATE INDEX IF NOT EXISTS idx_triangles_hop  ON triangles(hop_count);
        CREATE INDEX IF NOT EXISTS idx_triangles_pair_ab ON triangles(pair_ab);
        CREATE INDEX IF NOT EXISTS idx_triangles_pair_bc ON triangles(pair_bc);
        CREATE INDEX IF NOT EXISTS idx_triangles_pair_ca ON triangles(pair_ca);
        COMMIT;
    `);
}

// -----------------------------------------------------------------------------

export type PairRow = {
    address: string;
    factory: string;
    token0: string;
    token1: string;
    blockNumber: number;
    // Solidly-family only; NULL for pure V2 pairs. For v3, the pool's fee
    // tier as a fraction (0.003) when the creation event carried it.
    fee?: number | null;
    stable?: boolean | null;
    /** 'v2' (default) or 'v3'. */
    kind?: 'v2' | 'v3';
    /** CL variant for kind='v3': 'univ3' (default/NULL) | 'algebra-v1' | 'algebra-integral'. */
    clVariant?: string | null;
    /** v3 only. */
    tickSpacing?: number | null;
};

export type ReserveRow = {
    pair: string;
    reserves0: string;   // decimal string, parse to BigInt
    reserves1: string;
    blockNumber: number;
    updatedAt: number;
};

// -----------------------------------------------------------------------------

export class ArbitradeDB {
    readonly db: DB;

    constructor(filePath: string) {
        this.db = new Database(filePath);
        this.db.pragma('journal_mode = WAL');   // better concurrency
        this.db.pragma('synchronous = NORMAL'); // ~2x write speedup, still safe
        this.db.exec(SCHEMA);
        migratePairsColumns(this.db);
        migrateFactoriesFeeNullable(this.db);
        migrateTrianglesCanonicalIndex(this.db);
        migrateProbeColumns(this.db);
    }

    close() {
        this.db.close();
    }

    // ------------------------------------------- factories

    upsertFactory(f: { address: string; name: string; type: string; fee: number | null | undefined; deployBlock: number }) {
        this.db.prepare(`
            INSERT INTO factories (address, name, type, fee, deployBlock)
            VALUES (@address, @name, @type, @fee, @deployBlock)
            ON CONFLICT(address) DO UPDATE SET
                name        = excluded.name,
                type        = excluded.type,
                fee         = excluded.fee,
                deployBlock = excluded.deployBlock
        `).run({
            address: f.address.toLowerCase(),
            name: f.name,
            type: f.type,
            // Normalize undefined → null so better-sqlite3's parameter binding
            // treats it as SQL NULL rather than throwing.
            fee: f.fee ?? null,
            deployBlock: f.deployBlock,
        });
    }

    /** Fetch the cached deploy block for a factory, or null if unknown. */
    getFactoryDeployBlock(address: string): number | null {
        const row = this.db.prepare('SELECT deployBlock FROM factories WHERE address = ?')
            .get(address.toLowerCase()) as { deployBlock: number } | undefined;
        // Zero means "not yet discovered" — same as absent
        if (!row || !row.deployBlock) return null;
        return row.deployBlock;
    }

    // ------------------------------------------- pairs

    /**
     * Insert a batch of pairs in one transaction. Returns count inserted
     * (duplicates via UNIQUE(factory, address) are silently ignored).
     */
    insertPairs(rows: PairRow[]): number {
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO pairs (address, factory, token0, token1, blockNumber, fee, stable, kind, tickSpacing, cl_variant)
            VALUES (@address, @factory, @token0, @token1, @blockNumber, @fee, @stable, @kind, @tickSpacing, @cl_variant)
        `);
        const tx = this.db.transaction((rs: PairRow[]) => {
            let n = 0;
            for (const r of rs) {
                const res = stmt.run({
                    address: r.address.toLowerCase(),
                    factory: r.factory.toLowerCase(),
                    token0: r.token0.toLowerCase(),
                    token1: r.token1.toLowerCase(),
                    blockNumber: r.blockNumber,
                    fee: r.fee ?? null,
                    stable: r.stable == null ? null : (r.stable ? 1 : 0),
                    kind: r.kind ?? 'v2',
                    tickSpacing: r.tickSpacing ?? null,
                    cl_variant: r.clVariant ?? null,
                });
                if (res.changes > 0) n++;
            }
            return n;
        });
        return tx(rows);
    }

    countPairs(factory?: string): number {
        if (factory) {
            const row = this.db.prepare('SELECT COUNT(*) AS n FROM pairs WHERE factory = ?')
                .get(factory.toLowerCase()) as { n: number };
            return row.n;
        }
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM pairs').get() as { n: number };
        return row.n;
    }

    // ------------------------------------------- token metadata

    /**
     * Return all distinct token addresses referenced by any pair (or by
     * pairs matching optional filters). Used by \`yarn tokens\` to discover
     * what to fetch metadata for.
     *
     * `withReservesOnly`: if true, only tokens whose pairs have at least one
     * non-zero-reserve pool. Cuts the working set roughly in half on Polygon
     * (skips tokens that only appear in dead scaffold pairs).
     *
     * `unfetchedOnly`: skip tokens already in the tokens table with a
     * terminal fetchStatus ('ok', 'reverted', 'nocode'). Default true.
     */
    listPairTokens(opts: { withReservesOnly?: boolean; unfetchedOnly?: boolean } = {}): string[] {
        const withReserves = opts.withReservesOnly ?? false;
        const unfetched = opts.unfetchedOnly ?? true;

        // Build one query that unions token0/token1 across pairs, optionally
        // gated by "has any non-zero reserves ever", and optionally excludes
        // addresses already in tokens table.
        const pairFilter = withReserves
            ? `WHERE address IN (SELECT DISTINCT pair FROM reserves WHERE reserves0 > 0 OR reserves1 > 0)`
            : '';
        const query = `
            WITH pair_tokens AS (
                SELECT token0 AS address FROM pairs ${pairFilter}
                UNION
                SELECT token1 AS address FROM pairs ${pairFilter}
            )
            SELECT DISTINCT address FROM pair_tokens
            ${unfetched
                ? `WHERE address NOT IN (SELECT address FROM tokens WHERE fetchStatus IN ('ok', 'reverted', 'nocode'))`
                : ''}
        `;
        return (this.db.prepare(query).all() as Array<{ address: string }>).map(r => r.address);
    }

    /**
     * Upsert a batch of token metadata rows. Existing rows are updated;
     * discoveredAt is preserved.
     */
    upsertTokens(rows: Array<{
        address: string;
        symbol: string | null;
        name: string | null;
        decimals: number | null;
        fetchStatus: 'ok' | 'reverted' | 'nocode' | 'pending';
    }>): number {
        if (rows.length === 0) return 0;
        const now = Math.floor(Date.now() / 1000);
        const stmt = this.db.prepare(`
            INSERT INTO tokens (address, symbol, name, decimals, fetchStatus, fetchedAt, discoveredAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(address) DO UPDATE SET
                symbol = excluded.symbol,
                name = excluded.name,
                decimals = excluded.decimals,
                fetchStatus = excluded.fetchStatus,
                fetchedAt = excluded.fetchedAt
        `);
        const tx = this.db.transaction((batch: typeof rows) => {
            let n = 0;
            for (const r of batch) {
                stmt.run(r.address.toLowerCase(), r.symbol, r.name, r.decimals, r.fetchStatus, now, now);
                n++;
            }
            return n;
        });
        return tx(rows);
    }

    /**
     * Fetch known token metadata for a set of addresses. Returns a map keyed
     * by lowercased address. Missing addresses simply aren't in the returned
     * map. Used by display code (evaluator output, discovery.json) to swap
     * addresses for symbols.
     */
    getTokens(addresses: string[]): Map<string, { address: string; symbol: string | null; name: string | null; decimals: number | null; fetchStatus: string }> {
        const out = new Map();
        if (addresses.length === 0) return out;
        const lower = addresses.map(a => a.toLowerCase());
        // SQLite has a parameter limit (~999). Chunk defensively.
        const CHUNK = 500;
        for (let i = 0; i < lower.length; i += CHUNK) {
            const chunk = lower.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => '?').join(',');
            const rows = this.db.prepare(
                `SELECT address, symbol, name, decimals, fetchStatus FROM tokens WHERE address IN (${placeholders})`
            ).all(...chunk) as Array<{ address: string; symbol: string | null; name: string | null; decimals: number | null; fetchStatus: string }>;
            for (const r of rows) out.set(r.address, r);
        }
        return out;
    }

    tokenStats(): { total: number; ok: number; reverted: number; nocode: number; pending: number } {
        const rows = this.db.prepare(
            `SELECT fetchStatus, COUNT(*) AS n FROM tokens GROUP BY fetchStatus`
        ).all() as Array<{ fetchStatus: string; n: number }>;
        const out = { total: 0, ok: 0, reverted: 0, nocode: 0, pending: 0 };
        for (const r of rows) {
            out.total += r.n;
            (out as any)[r.fetchStatus] = r.n;
        }
        return out;
    }

    // ------------------------------------------- scan progress

    getScanProgress(factory: string): number | null {
        const row = this.db.prepare('SELECT lastBlock FROM scan_progress WHERE factory = ?')
            .get(factory.toLowerCase()) as { lastBlock: number } | undefined;
        return row?.lastBlock ?? null;
    }

    setScanProgress(factory: string, block: number) {
        this.db.prepare(`
            INSERT INTO scan_progress (factory, lastBlock, updatedAt)
            VALUES (?, ?, ?)
            ON CONFLICT(factory) DO UPDATE SET
                lastBlock = excluded.lastBlock,
                updatedAt = excluded.updatedAt
        `).run(factory.toLowerCase(), block, Math.floor(Date.now() / 1000));
    }

    // ------------------------------------------- reserves

    /**
     * Get pairs that need a reserves refresh. Optionally filter by:
     *   - factory: only pairs from this factory
     *   - maxAgeSeconds: skip pairs whose reserves were updated more recently
     *
     * Returns an array in the shape the fetcher wants (with the pair's factory
     * so the caller can group by group/family).
     */
    getPairsForReservesFetch(opts: {
        factory?: string;
        maxAgeSeconds?: number;
        /** If set, only return pairs whose factory is in this allowlist (lowercase). */
        factoryAllowlist?: string[];
        /**
         * Pool kinds to return. Default ['v2']: the balanceOf-based fetch is
         * WRONG for a v3 pool (its token balances are not its price), so v3
         * pools only come back when a caller asks for them explicitly.
         */
        kinds?: Array<'v2' | 'v3'>;
    } = {}): Array<{ pair: string; factory: string; token0: string; token1: string; clVariant: string | null }> {
        const wheres: string[] = [];
        const params: any[] = [];
        const kinds = opts.kinds ?? ['v2'];
        wheres.push(`p.kind IN (${kinds.map(() => '?').join(',')})`);
        params.push(...kinds);
        if (opts.factory) {
            wheres.push('p.factory = ?');
            params.push(opts.factory.toLowerCase());
        }
        if (opts.factoryAllowlist && opts.factoryAllowlist.length > 0) {
            const placeholders = opts.factoryAllowlist.map(() => '?').join(',');
            wheres.push(`p.factory IN (${placeholders})`);
            params.push(...opts.factoryAllowlist.map(a => a.toLowerCase()));
        }
        if (opts.maxAgeSeconds !== undefined) {
            const cutoff = Math.floor(Date.now() / 1000) - opts.maxAgeSeconds;
            // "r.updatedAt is null" means we've never fetched reserves for this pair yet
            wheres.push('(r.updatedAt IS NULL OR r.updatedAt < ?)');
            params.push(cutoff);
        }
        const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        return this.db.prepare(`
            SELECT p.address AS pair, p.factory, p.token0, p.token1, p.cl_variant AS clVariant
            FROM pairs p
            LEFT JOIN reserves r ON r.pair = p.address
            ${where}
            ORDER BY p.factory, p.address
        `).all(...params) as any;
    }

    /**
     * Count pairs whose factory is NOT in the provided allowlist. Useful for
     * detecting orphan pairs left behind by prior scans of factories that
     * have since been removed from the config.
     */
    countOrphanPairs(currentFactories: string[]): Array<{ factory: string; count: number }> {
        const allowlist = currentFactories.map(a => a.toLowerCase());
        const placeholders = allowlist.map(() => '?').join(',');
        const where = allowlist.length > 0
            ? `WHERE factory NOT IN (${placeholders})`
            : '';
        return this.db.prepare(`
            SELECT factory, COUNT(*) AS count
            FROM pairs
            ${where}
            GROUP BY factory
            ORDER BY count DESC
        `).all(...allowlist) as any;
    }

    /**
     * Delete pairs (and their reserves rows) whose factory is not in the
     * allowlist. Returns the number of pairs deleted.
     */
    deleteOrphanPairs(currentFactories: string[]): number {
        const allowlist = currentFactories.map(a => a.toLowerCase());
        const placeholders = allowlist.map(() => '?').join(',');
        const clause = allowlist.length > 0
            ? `WHERE factory NOT IN (${placeholders})`
            : '';
        const tx = this.db.transaction(() => {
            // First reserves rows referencing to-be-deleted pairs
            this.db.prepare(`
                DELETE FROM reserves
                WHERE pair IN (SELECT address FROM pairs ${clause})
            `).run(...allowlist);
            const info = this.db.prepare(`DELETE FROM pairs ${clause}`).run(...allowlist);
            return info.changes;
        });
        return tx();
    }

    /**
     * Upsert reserves for a batch of pairs. Zero-reserve pairs should be
     * filtered out by the caller (we don't waste space on dead pools).
     */
    upsertReserves(rows: Array<{
        pair: string;
        reserves0: bigint;
        reserves1: bigint;
        blockNumber: number;
    }>): number {
        const now = Math.floor(Date.now() / 1000);
        const stmt = this.db.prepare(`
            INSERT INTO reserves (pair, reserves0, reserves1, blockNumber, updatedAt)
            VALUES (@pair, @reserves0, @reserves1, @blockNumber, @updatedAt)
            ON CONFLICT(pair) DO UPDATE SET
                reserves0   = excluded.reserves0,
                reserves1   = excluded.reserves1,
                blockNumber = excluded.blockNumber,
                updatedAt   = excluded.updatedAt
        `);
        const tx = this.db.transaction((rs: typeof rows) => {
            let n = 0;
            for (const r of rs) {
                const res = stmt.run({
                    pair:      r.pair.toLowerCase(),
                    reserves0: r.reserves0.toString(),   // TEXT column, decimal string
                    reserves1: r.reserves1.toString(),
                    blockNumber: r.blockNumber,
                    updatedAt: now,
                });
                if (res.changes > 0) n++;
            }
            return n;
        });
        return tx(rows);
    }

    countReserves(): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM reserves').get() as { n: number };
        return row.n;
    }

    // ------------------------------------------- pair metadata (fee/stable for solidly-family)

    /**
     * Get pairs from a specific factory that lack fee/stable metadata.
     * If `forceRefresh` is true, returns ALL pairs regardless of whether
     * metadata is already populated (for the periodic refresh command).
     */
    getPairsForMetadataFetch(factory: string, forceRefresh: boolean): Array<{ pair: string; stable: number | null }> {
        const where = forceRefresh
            ? 'factory = ?'
            : 'factory = ? AND fee IS NULL';
        return this.db.prepare(`
            SELECT address AS pair, stable
            FROM pairs
            WHERE ${where}
            ORDER BY address
        `).all(factory.toLowerCase()) as any;
    }

    /** Update fee (and stable, if provided) for a single pair. */
    updatePairMetadata(rows: Array<{ pair: string; fee: number; stable?: boolean | null }>): number {
        const stmt = this.db.prepare(`
            UPDATE pairs
            SET fee = @fee,
                stable = COALESCE(@stable, stable)
            WHERE address = @pair
        `);
        const tx = this.db.transaction((rs: typeof rows) => {
            let n = 0;
            for (const r of rs) {
                const res = stmt.run({
                    pair:   r.pair.toLowerCase(),
                    fee:    r.fee,
                    stable: r.stable == null ? null : (r.stable ? 1 : 0),
                });
                if (res.changes > 0) n++;
            }
            return n;
        });
        return tx(rows);
    }

    // ------------------------------------------- orchestrator (piece 6) lookups

    /**
     * Look up token0/token1 for a batch of pair addresses. Used by the
     * orchestrator's hop builder to decide which side of a pair's swap()
     * call gets the nonzero amountOut, without an extra on-chain call —
     * token0/token1 ordering is fixed at pair creation and already cached
     * from the scan.
     */
    getPairTokenOrder(addresses: string[]): Map<string, { token0: string; token1: string }> {
        const out = new Map<string, { token0: string; token1: string }>();
        if (addresses.length === 0) return out;
        const lower = [...new Set(addresses.map(a => a.toLowerCase()))];
        const CHUNK = 500;
        for (let i = 0; i < lower.length; i += CHUNK) {
            const chunk = lower.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => '?').join(',');
            const rows = this.db.prepare(
                `SELECT address, token0, token1 FROM pairs WHERE address IN (${placeholders})`
            ).all(...chunk) as Array<{ address: string; token0: string; token1: string }>;
            for (const r of rows) out.set(r.address, { token0: r.token0, token1: r.token1 });
        }
        return out;
    }

    /**
     * One pair address for a given factory, for callers that just need a
     * representative sample (e.g. bytecode-based fee derivation) rather than
     * the full pair list. Picks deterministically (lowest address) so repeat
     * calls are stable. Returns null if the factory has no scanned pairs.
     */
    getSamplePairForFactory(factory: string): { pair: string; token0: string; token1: string } | null {
        const row = this.db.prepare(
            `SELECT address AS pair, token0, token1 FROM pairs WHERE factory = ? ORDER BY address LIMIT 1`
        ).get(factory.toLowerCase()) as { pair: string; token0: string; token1: string } | undefined;
        return row ?? null;
    }

    /**
     * Multiple pairs for a factory (up to `limit`), for callers that need to
     * try several until one has real trading activity — unlike
     * getSamplePairForFactory's single deterministic (lowest-address) pick,
     * which is fine for bytecode-based checks (any pair's code is the same
     * template) but can land on a long-dead or never-traded pair for anything
     * that needs REAL history (e.g. empirical fee recovery from Swap events;
     * see empirical-fee.ts).
     *
     * Ordered by raw reserve magnitude (larger of the two sides) descending,
     * NOT by address. Address ordering has zero correlation with trading
     * activity — Ethereum addresses are hash-derived, so "lowest address"
     * is effectively a random pick, and on a factory with hundreds of pairs
     * where only a handful are ever actually traded, a few random picks can
     * easily all miss. Reserve magnitude is an imperfect proxy (unnormalized
     * across token decimals — a low-decimal token with huge raw supply can
     * rank artificially high) but it's a REAL signal: a pair with reserves
     * near zero on either side has essentially never had a meaningful trade,
     * while a pair with substantial raw reserves on both sides is exactly
     * the kind of pair the evaluator's own liquidity filtering favors when
     * building real triangle candidates — i.e. this ordering is biased
     * toward the SAME pairs the orchestrator would actually consider, which
     * is the pool we actually want fee data from.
     */
    getPairsForFactory(factory: string, limit = 5): Array<{ pair: string; token0: string; token1: string }> {
        return this.db.prepare(`
            SELECT p.address AS pair, p.token0, p.token1
            FROM pairs p
            INNER JOIN reserves r ON r.pair = p.address
            WHERE p.factory = ? AND p.kind = 'v2'
            ORDER BY MAX(CAST(r.reserves0 AS REAL), CAST(r.reserves1 AS REAL)) DESC
            LIMIT ?
        `).all(factory.toLowerCase(), limit) as Array<{ pair: string; token0: string; token1: string }>;
    }

    // ------------------------------------------- safety probe (contracts/TokenProbe.sol, source/probe.ts)

    /**
     * Tokens eligible to appear in a triangle: the non-root side of every live
     * pair that touches a flash-loan root. (Every triangle the enumerator
     * builds is root→B→C→root, so B and C always have a direct root pair —
     * this is exactly the set that needs probing.) Skips tokens probed more
     * recently than `maxAgeSeconds` unless `refresh`.
     */
    getTokensToProbe(roots: string[], opts: { maxAgeSeconds: number; refresh: boolean; limit?: number }): string[] {
        const r = roots.map(a => a.toLowerCase());
        if (r.length === 0) return [];
        const ph = r.map(() => '?').join(',');
        const cutoff = Math.floor(Date.now() / 1000) - opts.maxAgeSeconds;
        const rows = this.db.prepare(`
            WITH eligible AS (
                SELECT DISTINCT CASE WHEN p.token0 IN (${ph}) THEN p.token1 ELSE p.token0 END AS t
                FROM pairs p
                INNER JOIN reserves rs ON rs.pair = p.address
                WHERE (p.token0 IN (${ph}) OR p.token1 IN (${ph}))
                  AND rs.reserves0 != '0' AND rs.reserves1 != '0'
            )
            SELECT e.t AS address
            FROM eligible e
            LEFT JOIN tokens tk ON tk.address = e.t
            WHERE e.t NOT IN (${ph})
              AND (? = 1 OR tk.probedAt IS NULL OR tk.probedAt < ?)
            ORDER BY (tk.probedAt IS NOT NULL), e.t
            ${opts.limit ? 'LIMIT ?' : ''}
        `).all(...r, ...r, ...r, ...r, opts.refresh ? 1 : 0, cutoff, ...(opts.limit ? [opts.limit] : [])) as Array<{ address: string }>;
        return rows.map(x => x.address);
    }

    /**
     * Candidate root pairs to probe a token through, most liquid first by the
     * root side's raw reserve. Skips pairs already known restricted and pairs
     * from factories outside `allowedFactories` (i.e. blacklisted).
     */
    getRootPairsForToken(token: string, roots: string[], allowedFactories: string[], limit = 3): Array<{ pair: string; factory: string; root: string; rootReserve: string }> {
        const t = token.toLowerCase();
        const r = roots.map(a => a.toLowerCase());
        const f = allowedFactories.map(a => a.toLowerCase());
        if (r.length === 0 || f.length === 0) return [];
        const rph = r.map(() => '?').join(',');
        const fph = f.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT p.address AS pair, p.factory,
                   CASE WHEN p.token0 = ? THEN p.token1 ELSE p.token0 END AS root,
                   CASE WHEN p.token0 = ? THEN rs.reserves1 ELSE rs.reserves0 END AS rootReserve
            FROM pairs p
            INNER JOIN reserves rs ON rs.pair = p.address
            WHERE ((p.token0 = ? AND p.token1 IN (${rph})) OR (p.token1 = ? AND p.token0 IN (${rph})))
              AND p.factory IN (${fph})
              AND p.kind = 'v2'   -- the probe swaps through pair.swap(); v3 pools need a callback
              AND (p.stable IS NULL OR p.stable = 0)
              AND (p.probeStatus IS NULL OR p.probeStatus != 'pair-restricted')
              AND rs.reserves0 != '0' AND rs.reserves1 != '0'
            ORDER BY CAST(rootReserve AS REAL) DESC
            LIMIT ?
        `).all(t, t, t, ...r, t, ...r, ...f, limit) as Array<{ pair: string; factory: string; root: string; rootReserve: string }>;
    }

    setTokenProbe(address: string, p: { status: string; buyTaxBps: number | null; sellTaxBps: number | null; reason: string; pair: string | null }): void {
        const now = Math.floor(Date.now() / 1000);
        this.db.prepare(`
            INSERT INTO tokens (address, fetchStatus, discoveredAt, probeStatus, buyTaxBps, sellTaxBps, probeReason, probedAt, probedPair)
            VALUES (@address, 'pending', @now, @status, @buyTaxBps, @sellTaxBps, @reason, @now, @pair)
            ON CONFLICT(address) DO UPDATE SET
                probeStatus = excluded.probeStatus,
                buyTaxBps   = excluded.buyTaxBps,
                sellTaxBps  = excluded.sellTaxBps,
                probeReason = excluded.probeReason,
                probedAt    = excluded.probedAt,
                probedPair  = excluded.probedPair
        `).run({ address: address.toLowerCase(), now, status: p.status, buyTaxBps: p.buyTaxBps, sellTaxBps: p.sellTaxBps, reason: p.reason.slice(0, 300), pair: p.pair?.toLowerCase() ?? null });
    }

    setPairProbe(pair: string, status: string, reason: string): void {
        this.db.prepare(`UPDATE pairs SET probeStatus = ?, probeReason = ?, probedAt = ? WHERE address = ?`)
            .run(status, reason.slice(0, 300), Math.floor(Date.now() / 1000), pair.toLowerCase());
    }

    /** Per-factory tally of probed pairs — a factory whose probed pairs are all restricted is a honeypot/restricted DEX. */
    getFactoryProbeSummary(): Array<{ factory: string; restricted: number; ok: number; rejects: number }> {
        return this.db.prepare(`
            SELECT factory,
                   SUM(probeStatus = 'pair-restricted') AS restricted,
                   SUM(probeStatus = 'ok')              AS ok,
                   SUM(probeStatus = 'pair-rejects')    AS rejects
            FROM pairs
            WHERE probeStatus IS NOT NULL
            GROUP BY factory
            ORDER BY restricted DESC
        `).all() as Array<{ factory: string; restricted: number; ok: number; rejects: number }>;
    }

    getTokenProbeStats(): Record<string, number> {
        const rows = this.db.prepare(`SELECT COALESCE(probeStatus, 'unprobed') AS s, COUNT(*) AS n FROM tokens GROUP BY s`).all() as Array<{ s: string; n: number }>;
        return Object.fromEntries(rows.map(r => [r.s, r.n]));
    }

    // ------------------------------------------- triangle enumeration inputs

    /**
     * Load every pair with a live non-zero reserve, joined with its factory
     * and current fee/stable. Returned as a flat array — the enumerator
     * builds its own indexes from this. Excludes zero-reserve pairs (no arb
     * point) and stable pools by default (constant-product math is wrong for
     * them; separate stable-swap support is future work).
     *
     * Also excludes, by default, anything the safety probe flagged: pairs
     * whose swap() rejects outsiders, and pairs where EITHER token is a
     * honeypot / fee-on-transfer / nonstandard / dead token. Never-probed
     * pairs and tokens (probeStatus NULL) are kept — excluding the unknown
     * would empty the graph before the first probe run.
     */
    getPairsForEnumeration(opts: {
        includeStable?: boolean;
        includeUnsafe?: boolean;
        /** Pool kinds to include. Default: all. The hot index passes ['v2'] until it can score v3. */
        kinds?: Array<'v2' | 'v3'>;
    } = {}): Array<{
        pair:        string;
        factory:     string;
        token0:      string;
        token1:      string;
        fee:         number | null;   // per-pair for v2fee/solidly/v3; NULL for pure v2
        stable:      number | null;   // 0/1 or NULL
        kind:        'v2' | 'v3';
    }> {
        const kindClause = opts.kinds ? `AND p.kind IN (${opts.kinds.map(k => `'${k === 'v3' ? 'v3' : 'v2'}'`).join(',')})` : '';
        const includeStable = opts.includeStable ?? false;
        const includeUnsafe = opts.includeUnsafe ?? false;
        const stableClause = includeStable ? '' : 'AND (p.stable IS NULL OR p.stable = 0)';
        const badTokens = UNSAFE_TOKEN_STATUSES.map(s => `'${s}'`).join(',');
        const badPairs = UNSAFE_PAIR_STATUSES.map(s => `'${s}'`).join(',');
        const unsafeClause = includeUnsafe ? '' : `
            AND (p.probeStatus IS NULL OR p.probeStatus NOT IN (${badPairs}))
            AND p.token0 NOT IN (SELECT address FROM tokens WHERE probeStatus IN (${badTokens}))
            AND p.token1 NOT IN (SELECT address FROM tokens WHERE probeStatus IN (${badTokens}))`;
        return this.db.prepare(`
            SELECT p.address AS pair, p.factory, p.token0, p.token1, p.fee, p.stable, p.kind, p.cl_variant
            FROM pairs p
            INNER JOIN reserves r ON r.pair = p.address
            WHERE r.reserves0 != '0' AND r.reserves1 != '0'
            ${kindClause}
            ${stableClause}
            ${unsafeClause}
            ORDER BY p.address
        `).all() as any;
    }

    // ------------------------------------------- concentrated-liquidity state

    /**
     * Store one batch of v3 pool reads, atomically per batch: pool_state is
     * upserted, the pool's tick table is REPLACED (a tick that was burned to
     * zero since the last read must disappear, not linger), pairs.fee and
     * pairs.tickSpacing are refreshed from the pool, and the reserves row is
     * set to the supplied virtual reserves.
     *
     * A pool that did not answer (state === null) gets zero reserves, so a
     * pool that stops responding drops out of enumeration instead of being
     * scored on its last known price forever.
     */
    /**
     * Zero the reserves of pairs the reachability prefilter dropped, so a
     * stale price from an earlier full read cannot linger in enumeration.
     * Only rows that are not already zero are touched, which keeps a run
     * that drops millions of pairs from rewriting millions of rows.
     */
    zeroReserves(pairs: string[]): number {
        const now = Math.floor(Date.now() / 1000);
        const st = this.db.prepare(`UPDATE reserves SET reserves0 = '0', reserves1 = '0', updatedAt = ?
            WHERE pair = ? AND (reserves0 != '0' OR reserves1 != '0')`);
        let n = 0;
        this.db.transaction(() => { for (const p of pairs) n += st.run(now, p.toLowerCase()).changes; })();
        return n;
    }

    /** Cached root-pool balances checked at or after `since` (unix s), by lowercase pool. */
    getRootChecks(since: number): Map<string, { bal0: bigint; bal1: bigint }> {
        const out = new Map<string, { bal0: bigint; bal1: bigint }>();
        for (const r of this.db.prepare('SELECT pool, bal0, bal1 FROM root_checks WHERE checkedAt >= ?').iterate(since) as any) {
            out.set(r.pool, { bal0: BigInt(r.bal0), bal1: BigInt(r.bal1) });
        }
        return out;
    }

    putRootChecks(rows: Array<{ pool: string; bal0: bigint; bal1: bigint }>): void {
        const now = Math.floor(Date.now() / 1000);
        const st = this.db.prepare(`INSERT INTO root_checks (pool, bal0, bal1, checkedAt) VALUES (?, ?, ?, ?)
            ON CONFLICT(pool) DO UPDATE SET bal0 = excluded.bal0, bal1 = excluded.bal1, checkedAt = excluded.checkedAt`);
        this.db.transaction(() => { for (const r of rows) st.run(r.pool.toLowerCase(), r.bal0.toString(), r.bal1.toString(), now); })();
    }

    upsertV3States(rows: Array<{
        pool: string;
        blockNumber: number;
        state: {
            sqrtPriceX96: bigint; tick: number; liquidity: bigint; fee: number; tickSpacing: number;
            windowLow: number; windowHigh: number; ticks: Array<{ index: number; liquidityNet: bigint }>;
        } | null;
        reserves0: bigint;
        reserves1: bigint;
    }>): number {
        const now = Math.floor(Date.now() / 1000);
        const putState = this.db.prepare(`
            INSERT INTO pool_state (pool, sqrtPriceX96, tick, liquidity, fee, tickSpacing, windowLow, windowHigh, blockNumber, updatedAt)
            VALUES (@pool, @sqrtPriceX96, @tick, @liquidity, @fee, @tickSpacing, @windowLow, @windowHigh, @blockNumber, @updatedAt)
            ON CONFLICT(pool) DO UPDATE SET
                sqrtPriceX96 = excluded.sqrtPriceX96, tick = excluded.tick, liquidity = excluded.liquidity,
                fee = excluded.fee, tickSpacing = excluded.tickSpacing,
                windowLow = excluded.windowLow, windowHigh = excluded.windowHigh,
                blockNumber = excluded.blockNumber, updatedAt = excluded.updatedAt
        `);
        const dropTicks = this.db.prepare('DELETE FROM pool_ticks WHERE pool = ?');
        const putTick = this.db.prepare('INSERT INTO pool_ticks (pool, tick, liquidityNet) VALUES (?, ?, ?)');
        const putPair = this.db.prepare('UPDATE pairs SET fee = ?, tickSpacing = ? WHERE address = ?');
        const putRes = this.db.prepare(`
            INSERT INTO reserves (pair, reserves0, reserves1, blockNumber, updatedAt)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(pair) DO UPDATE SET
                reserves0 = excluded.reserves0, reserves1 = excluded.reserves1,
                blockNumber = excluded.blockNumber, updatedAt = excluded.updatedAt
        `);
        const tx = this.db.transaction(() => {
            let n = 0;
            for (const r of rows) {
                const pool = r.pool.toLowerCase();
                if (r.state) {
                    const s = r.state;
                    putState.run({
                        pool, sqrtPriceX96: s.sqrtPriceX96.toString(), tick: s.tick, liquidity: s.liquidity.toString(),
                        fee: s.fee, tickSpacing: s.tickSpacing, windowLow: s.windowLow, windowHigh: s.windowHigh,
                        blockNumber: r.blockNumber, updatedAt: now,
                    });
                    dropTicks.run(pool);
                    for (const t of s.ticks) putTick.run(pool, t.index, t.liquidityNet.toString());
                    putPair.run(s.fee / 1e6, s.tickSpacing, pool);
                    n++;
                }
                putRes.run(pool, r.reserves0.toString(), r.reserves1.toString(), r.blockNumber, now);
            }
            return n;
        });
        return tx();
    }

    /**
     * Load stored v3 state, in the V3Pool shape calculus-v3.js consumes
     * (ticks ascending). Pass `pools` to restrict; omit for all.
     */
    loadV3States(pools?: Iterable<string>): Map<string, {
        sqrtPriceX96: bigint; tick: number; liquidity: bigint; fee: number; tickSpacing: number;
        windowLow: number; windowHigh: number; ticks: Array<{ index: number; liquidityNet: bigint }>;
        blockNumber: number; updatedAt: number;
    }> {
        const want = pools ? new Set([...pools].map(p => p.toLowerCase())) : null;
        const out = new Map<string, any>();
        for (const r of this.db.prepare('SELECT * FROM pool_state').iterate() as Iterable<any>) {
            if (want && !want.has(r.pool)) continue;
            out.set(r.pool, {
                sqrtPriceX96: BigInt(r.sqrtPriceX96), tick: r.tick, liquidity: BigInt(r.liquidity),
                fee: r.fee, tickSpacing: r.tickSpacing, windowLow: r.windowLow, windowHigh: r.windowHigh,
                ticks: [], blockNumber: r.blockNumber, updatedAt: r.updatedAt,
            });
        }
        for (const t of this.db.prepare('SELECT pool, tick, liquidityNet FROM pool_ticks ORDER BY pool, tick').iterate() as Iterable<any>) {
            const s = out.get(t.pool);
            if (s) s.ticks.push({ index: t.tick, liquidityNet: BigInt(t.liquidityNet) });
        }
        return out;
    }

    // ------------------------------------------- triangles

    /**
     * Drop all triangles for regeneration. The evaluator doesn't hold long-term
     * state on triangles, so blowing the table away and rebuilding is cheap.
     */
    clearTriangles(): number {
        const info = this.db.prepare('DELETE FROM triangles').run();
        return info.changes;
    }

    clearTrianglesByRoot(rootToken: string): number {
        const info = this.db.prepare('DELETE FROM triangles WHERE root_token = ?')
            .run(rootToken.toLowerCase());
        return info.changes;
    }

    countTriangles(): { total: number; byHop: Record<number, number>; byRoot: Record<string, number> } {
        const total = (this.db.prepare('SELECT COUNT(*) AS n FROM triangles').get() as any).n;
        const byHopRows = this.db.prepare('SELECT hop_count, COUNT(*) AS n FROM triangles GROUP BY hop_count').all() as any[];
        const byRootRows = this.db.prepare('SELECT root_token, COUNT(*) AS n FROM triangles GROUP BY root_token').all() as any[];
        const byHop: Record<number, number> = {};
        for (const r of byHopRows) byHop[r.hop_count] = r.n;
        const byRoot: Record<string, number> = {};
        for (const r of byRootRows) byRoot[r.root_token] = r.n;
        return { total, byHop, byRoot };
    }

    /**
     * Drop the triangles table's 5 SECONDARY indexes (root/hop/pair_ab/bc/ca).
     * Deliberately does NOT drop idx_triangles_canonical — that's the
     * uniqueness constraint that makes INSERT OR IGNORE correctly de-dupe
     * both within a batch AND against pre-existing rows left by a --root
     * partial run. The same physical triangle can legitimately be reachable
     * from more than one flash-loan root (canonical is built from sorted pair
     * addresses only, not the root token), so cross-root canonical collisions
     * are a real, expected case — dropping the uniqueness index would let
     * duplicates land silently and then crash the index rebuild afterward.
     * Used around bulk inserts — see insertTriangles().
     */
    dropTriangleIndexes(): void {
        this.db.exec(`
            DROP INDEX IF EXISTS idx_triangles_root;
            DROP INDEX IF EXISTS idx_triangles_hop;
            DROP INDEX IF EXISTS idx_triangles_pair_ab;
            DROP INDEX IF EXISTS idx_triangles_pair_bc;
            DROP INDEX IF EXISTS idx_triangles_pair_ca;
        `);
    }

    /**
     * Recreate the triangles table's 5 secondary indexes. SQLite builds a
     * fresh index on a populated table via a single sorted pass —
     * dramatically faster than the incremental B-tree updates that happen on
     * every row during a plain INSERT loop, which is what makes this
     * drop/insert/rebuild pattern worthwhile for millions of rows.
     */
    createTriangleIndexes(): void {
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_triangles_root ON triangles(root_token);
            CREATE INDEX IF NOT EXISTS idx_triangles_hop  ON triangles(hop_count);
            CREATE INDEX IF NOT EXISTS idx_triangles_pair_ab ON triangles(pair_ab);
            CREATE INDEX IF NOT EXISTS idx_triangles_pair_bc ON triangles(pair_bc);
            CREATE INDEX IF NOT EXISTS idx_triangles_pair_ca ON triangles(pair_ca);
        `);
    }

    /**
     * Bulk insert triangles, optimized for large batches (Polygon-scale:
     * millions of rows). Two combined optimizations, both measured against
     * this exact table shape before landing (see project notes — real gains
     * were more modest than index theory alone suggested, roughly 1.7x
     * combined on a 500K-row file-backed benchmark, not a dramatic 5-10x):
     *
     *   1. Drop the 5 secondary indexes before inserting, rebuild them in one
     *      sorted pass after (see dropTriangleIndexes/createTriangleIndexes).
     *      The canonical uniqueness index stays live throughout — needed for
     *      correct de-duplication both within a batch and against pre-existing
     *      rows from a --root partial run (a physical triangle can legitimately
     *      be reachable from more than one flash-loan root).
     *   2. Multi-row batched INSERT (BATCH rows bound per statement instead of
     *      one) to cut JS<->native call overhead. BATCH=75 keeps total bound
     *      params (75*13=975) safely under SQLite's historic 999-variable
     *      limit for portability, even though better-sqlite3's bundled SQLite
     *      defaults much higher in practice.
     *
     * `synchronous` is relaxed for the duration (restored after) — safe
     * because triangles are a fully regenerable cache (see enumerator.ts),
     * so there's no durability risk worth paying for in this window.
     */
    insertTriangles(rows: Array<{
        root_token: string;
        hop_count: number;
        token_a: string;
        token_b: string;
        token_c: string;
        pair_ab: string;
        pair_bc: string;
        pair_ca: string;
        factory_ab: string;
        factory_bc: string;
        factory_ca: string;
        canonical: string;
    }>): number {
        if (rows.length === 0) return 0;
        const now = Math.floor(Date.now() / 1000);

        this.dropTriangleIndexes();

        const BATCH = 75;
        const COLS_PER_ROW = 13;
        const rowPlaceholder = '(' + Array(COLS_PER_ROW).fill('?').join(',') + ')';
        const batchStmt = this.db.prepare(`
            INSERT OR IGNORE INTO triangles (
                root_token, hop_count, token_a, token_b, token_c,
                pair_ab, pair_bc, pair_ca,
                factory_ab, factory_bc, factory_ca,
                canonical, createdAt
            ) VALUES ${Array(BATCH).fill(rowPlaceholder).join(',')}
        `);
        const singleStmt = this.db.prepare(`
            INSERT OR IGNORE INTO triangles (
                root_token, hop_count, token_a, token_b, token_c,
                pair_ab, pair_bc, pair_ca,
                factory_ab, factory_bc, factory_ca,
                canonical, createdAt
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);

        const toParams = (r: (typeof rows)[number]) => [
            r.root_token.toLowerCase(), r.hop_count,
            r.token_a.toLowerCase(), r.token_b.toLowerCase(), r.token_c.toLowerCase(),
            r.pair_ab.toLowerCase(), r.pair_bc.toLowerCase(), r.pair_ca.toLowerCase(),
            r.factory_ab.toLowerCase(), r.factory_bc.toLowerCase(), r.factory_ca.toLowerCase(),
            r.canonical, now,
        ];

        const prevSync = this.db.pragma('synchronous', { simple: true }) as number;
        this.db.pragma('synchronous = OFF'); // safe: triangles are fully regenerable, see doc above

        let totalInserted = 0;
        try {
            const tx = this.db.transaction((rs: typeof rows) => {
                let i = 0;
                for (; i + BATCH <= rs.length; i += BATCH) {
                    const flat: Array<string | number> = [];
                    for (let j = i; j < i + BATCH; j++) flat.push(...toParams(rs[j]));
                    const res = batchStmt.run(...flat);
                    totalInserted += res.changes;
                }
                for (; i < rs.length; i++) {
                    const res = singleStmt.run(...toParams(rs[i]));
                    totalInserted += res.changes;
                }
            });
            tx(rows);
        } finally {
            this.db.pragma(`synchronous = ${prevSync}`);
            this.createTriangleIndexes();
        }

        return totalInserted;
    }
}
