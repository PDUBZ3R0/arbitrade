// -----------------------------------------------------------------------------
// Envio HyperSync adapter for find-factories.
//
// Wraps @envio-dev/hypersync-client to sweep a block range for PairCreated
// emitters. Same signature shape as sweepRpc / sweepEtherscan.
//
// Setup:
//   1. Sign up at https://envio.dev/ (free)
//   2. Put your token in .env as ENVIO_API_TOKEN=...
//   3. Ensure the chain has hypersyncUrl set in @chains.json5
//
// Docs: https://docs.envio.dev/docs/HyperSync/hypersync-query
// GitHub: https://github.com/enviodev/hypersync-client-node
//
// Key facts about the API (verified against installed npm package v1.4+):
//   - Client construction: the installed NAPI bindings expose a static
//     factory `HypersyncClient.new({...})`. Using `new HypersyncClient(...)`
//     throws "Class contains no constructor". Some docs pages show `new`
//     usage — they're incorrect for the current package. We try `.new()`
//     first and fall back to `new` for future versions that may support it.
//   - Config field name: `apiToken` (newer) or `bearerToken` (older). We
//     pass both; extras are ignored.
//   - Field selection uses PascalCase strings matching NAPI enum variants:
//     'Address', 'BlockNumber', 'Topic0', etc. NOT snake_case, NOT camelCase.
//     See the LogField/BlockField/TraceField/TransactionField enums in
//     node_modules/@envio-dev/hypersync-client/index.d.ts for the exact set.
//   - toBlock is EXCLUSIVE (so passing toBlock=100 returns blocks 0..99)
//   - Response has `.data.logs`, `.nextBlock`, and optional `.archiveHeight`
//   - nextBlock is the block immediately AFTER the last block included
//     (use it as the next fromBlock)
//   - Response fields come back camelCased by the NAPI bindings even though
//     the query uses snake_case
// -----------------------------------------------------------------------------

import type { FactoryCandidate } from './find-factories.ts';

const RUNAWAY_LIMIT = 10_000_000;  // sanity cap on total logs

/**
 * Sweep a chain range for a specific topic0 via HyperSync. Same signature
 * as sweepRpc / sweepEtherscan.
 *
 * Returns a Map<factoryAddress, FactoryCandidate> of unique emitters. On
 * abort, returns what's been collected so far.
 */
export async function sweepHyperSync(
    hypersyncUrl: string,
    apiToken: string,
    fromBlock: number,
    toBlock: number,
    topic: string,
    topicLabel: 'v2' | 'solidly',
    into?: Map<string, FactoryCandidate>,
    abortSignal?: AbortSignal,
): Promise<Map<string, FactoryCandidate>> {
    const emitters = into ?? new Map<string, FactoryCandidate>();

    // Dynamic import so the package is optional — projects that don't set
    // hypersyncUrl on any chain never need to install it.
    let mod: any;
    try {
        mod = await import('@envio-dev/hypersync-client');
    } catch (err) {
        throw new Error(
            `@envio-dev/hypersync-client not installed. Run:\n` +
            `  yarn add @envio-dev/hypersync-client\n` +
            `Original error: ${(err as Error).message}`
        );
    }

    const HypersyncClient = mod.HypersyncClient;
    if (!HypersyncClient) {
        throw new Error(
            `@envio-dev/hypersync-client exports unexpected shape. ` +
            `Available exports: ${Object.keys(mod).join(', ')}`
        );
    }

    // Construct client. NAPI-rs exposes this as a static factory
    // `HypersyncClient.new({...})` in most installed versions — using
    // `new HypersyncClient(...)` throws `Class contains no constructor`.
    // Try the factory first, fall back to `new` if a future version drops it.
    // Pass both `apiToken` and `bearerToken` because the field name has
    // changed across versions; extras are ignored.
    const clientConfig = { url: hypersyncUrl, apiToken, bearerToken: apiToken };
    let client: any;
    if (typeof HypersyncClient.new === 'function') {
        client = HypersyncClient.new(clientConfig);
    } else {
        client = new HypersyncClient(clientConfig);
    }

    // Query shape. Field names in fieldSelection MUST be snake_case strings —
    // the underlying protocol uses snake_case even though the Node bindings
    // return response fields camelCased.
    //
    // toBlock is EXCLUSIVE in HyperSync's protocol. Caller passes an inclusive
    // upper bound, so we add 1 to convert.
    let query: any = {
        fromBlock,
        toBlock: toBlock + 1,
        logs: [{ topics: [[topic]] }],
        fieldSelection: {
            // Only log fields needed. block_number is on the log itself, so we
            // don't need to select any block-level fields. Omitting block
            // sidesteps a NAPI enum-variant mismatch where `block: ['number']`
            // is rejected as "not a variant of BlockField".
            log: ['Address', 'BlockNumber'],
        },
        // Only return log data — no automatic joining to txns/traces/blocks.
        joinMode: mod.JoinMode?.JoinNothing ?? 'JoinNothing',
    };

    let totalLogs = 0;
    let batchIndex = 0;

    // Paginate until we've covered the requested range. HyperSync's per-request
    // execution time budget (~5s) means one call can advance many blocks; we
    // keep calling with fromBlock=res.nextBlock until we've covered toBlock.
    while (true) {
        if (abortSignal?.aborted) {
            process.stdout.write(`\n  [hypersync] aborted — returning partial results (${emitters.size} emitters so far)\n`);
            return emitters;
        }

        let res: any;
        try {
            res = await client.get(query);
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            if (/token|auth|401|403/i.test(msg)) {
                throw new Error(`HyperSync auth failed. Check ENVIO_API_TOKEN is valid. (${msg})`);
            }
            throw new Error(`HyperSync query failed at block ${query.fromBlock}: ${msg}`);
        }

        batchIndex++;
        const logs: any[] = res?.data?.logs ?? [];
        totalLogs += logs.length;

        for (const log of logs) {
            // Address is required. Node bindings return camelCase (address,
            // blockNumber) but be defensive against future variants.
            const addr = log.address ?? log.Address;
            if (!addr) continue;
            const emitter = addr.toLowerCase();
            const blockNum = log.blockNumber ?? log.block_number ?? query.fromBlock;

            const existing = emitters.get(emitter);
            if (existing) {
                existing.pairCreatedCount++;
                if (blockNum > existing.lastBlockSeen)  existing.lastBlockSeen  = blockNum;
                if (blockNum < existing.firstBlockSeen) existing.firstBlockSeen = blockNum;
                existing.matchedTopics.add(topicLabel);
            } else {
                emitters.set(emitter, {
                    address: emitter,
                    pairCreatedCount: 1,
                    firstBlockSeen: blockNum,
                    lastBlockSeen:  blockNum,
                    matchedTopics: new Set([topicLabel]),
                });
            }
        }

        process.stdout.write(
            `\r  [hypersync] ${((query.fromBlock - fromBlock) / Math.max(1, toBlock - fromBlock) * 100).toFixed(1).padStart(5)}% — ${emitters.size} unique emitters, ${totalLogs} logs`
        );

        if (totalLogs > RUNAWAY_LIMIT) {
            process.stdout.write(`\n  [hypersync] runaway limit hit (${RUNAWAY_LIMIT} logs) — stopping\n`);
            break;
        }

        // Advance. If nextBlock covers our toBlock, we're done.
        const nextBlock: number | undefined = res?.nextBlock;
        if (nextBlock == null) break;
        if (nextBlock >= query.toBlock) break;
        if (nextBlock <= query.fromBlock) {
            // Guard against infinite loops if server returns non-progressing nextBlock
            process.stdout.write(`\n  [hypersync] nextBlock (${nextBlock}) did not advance past fromBlock (${query.fromBlock}) — stopping\n`);
            break;
        }
        query = { ...query, fromBlock: nextBlock };
    }
    process.stdout.write('\n');
    return emitters;
}

/**
 * Ask HyperSync for the current archive height (a proxy for "chain head"
 * suitable for setting to-block on scans). Uses a minimal query to trigger
 * an archiveHeight response.
 *
 * This lets find-factories work on chains whose public RPC blocks
 * anonymous requests (e.g. polygon-rpc.com).
 */
export async function hypersyncArchiveHeight(hypersyncUrl: string, apiToken: string): Promise<number> {
    const mod: any = await import('@envio-dev/hypersync-client');
    const HypersyncClient = mod.HypersyncClient;
    if (!HypersyncClient) throw new Error('HypersyncClient not exported by @envio-dev/hypersync-client');

    // Same constructor pattern as sweepHyperSync — factory first, fall back to `new`.
    const clientConfig = { url: hypersyncUrl, apiToken, bearerToken: apiToken };
    const client: any = typeof HypersyncClient.new === 'function'
        ? HypersyncClient.new(clientConfig)
        : new HypersyncClient(clientConfig);

    // Small query — we don't care about data, just archiveHeight in the response.
    const res: any = await client.get({
        fromBlock: 0,
        toBlock:   1,
        logs:      [],
        fieldSelection: { block: ['number'] },
    });
    const h = res?.archiveHeight;
    if (typeof h !== 'number' || h <= 0) {
        throw new Error(`HyperSync returned no archiveHeight (response keys: ${Object.keys(res ?? {}).join(', ')})`);
    }
    return h;
}

/**
 * Fetch parsed PairCreated events for a single factory over a block range,
 * returning the same shape as verify-factory's tryRpcLogs. Handles both V2
 * and Solidly-native event layouts.
 *
 * This replaces the chunked getLogs storm in verify-factory's fetchSamplePairs,
 * which is the main hang source on rate-limited public RPCs.
 *
 * Data layout:
 *   V2 topic:      token0 in topic[1], token1 in topic[2], pair in data (32-byte word)
 *   Solidly topic: token0 in topic[1], token1 in topic[2], data = [bool stable][address pair]
 */
export async function samplePairsFromFactoryHyperSync(
    hypersyncUrl: string,
    apiToken: string,
    factory: string,
    fromBlock: number,
    toBlock: number,
    topic: string,
    isSolidly: boolean,
): Promise<Array<{ pair: string; token0: string; token1: string; blockNumber: number; stable: boolean | null }>> {
    const mod: any = await import('@envio-dev/hypersync-client');
    const HypersyncClient = mod.HypersyncClient;
    if (!HypersyncClient) throw new Error('HypersyncClient not exported by @envio-dev/hypersync-client');

    const clientConfig = { url: hypersyncUrl, apiToken, bearerToken: apiToken };
    const client: any = typeof HypersyncClient.new === 'function'
        ? HypersyncClient.new(clientConfig)
        : new HypersyncClient(clientConfig);

    // Filter logs by factory address AND topic0. This is far more selective
    // than the chain-wide sweep, so it completes in one or a few batches even
    // for prolific factories.
    let query: any = {
        fromBlock,
        toBlock: toBlock + 1,   // HyperSync toBlock is exclusive
        logs: [{
            address: [factory.toLowerCase()],
            topics: [[topic]],
        }],
        fieldSelection: {
            // Need Data + Topic1/Topic2 to parse token addresses + pair.
            // Topic0 is redundant (we already know it) but selecting doesn't cost.
            log: ['Address', 'BlockNumber', 'Data', 'Topic0', 'Topic1', 'Topic2'],
        },
        joinMode: mod.JoinMode?.JoinNothing ?? 2,
    };

    const hits: Array<{ pair: string; token0: string; token1: string; blockNumber: number; stable: boolean | null }> = [];
    // Cap iterations — for verify-factory we typically want one sample pair,
    // not the whole history. Two full batches is more than enough.
    for (let i = 0; i < 5; i++) {
        const res: any = await client.get(query);
        const logs: any[] = res?.data?.logs ?? [];
        for (const log of logs) {
            const topics: any[] = log.topics ?? [];
            const data: string = log.data ?? log.Data ?? '';
            if (topics.length < 3 || data.length < 66) continue;

            const token0 = '0x' + (topics[1] ?? '').slice(-40);
            const token1 = '0x' + (topics[2] ?? '').slice(-40);
            let pair: string;
            let stable: boolean | null = null;
            if (isSolidly) {
                stable = BigInt('0x' + data.slice(2, 66)) === 1n;
                pair = '0x' + data.slice(66, 130).slice(-40);
            } else {
                pair = '0x' + data.slice(2, 66).slice(-40);
            }
            hits.push({
                pair,
                token0,
                token1,
                blockNumber: log.blockNumber ?? log.block_number ?? fromBlock,
                stable,
            });
        }

        // Early-out: verify-factory only needs 1 sample. Return as soon as we have any.
        if (hits.length > 0) return hits;

        const nextBlock: number | undefined = res?.nextBlock;
        if (nextBlock == null || nextBlock >= query.toBlock || nextBlock <= query.fromBlock) break;
        query = { ...query, fromBlock: nextBlock };
    }
    return hits;
}

// -----------------------------------------------------------------------------
// Scanner adapter: stream parsed PairCreated events for a single factory,
// invoking a callback per batch. This lets `yarn scan` skip its chunked-RPC
// dance entirely and just walk HyperSync's natural pagination.
// -----------------------------------------------------------------------------

export type ScannedPair = {
    pair: string;
    token0: string;
    token1: string;
    blockNumber: number;
    stable: boolean | null;
};

/**
 * Stream parsed PairCreated events for one factory over [fromBlock, toBlock].
 * Calls `onBatch` once per HyperSync batch with the parsed pairs AND the
 * highest block covered by this batch (so the caller can persist scan
 * progress incrementally and resume cleanly on failure).
 *
 * Callbacks are `await`ed so the DB insert + progress update happen before
 * the next HyperSync call.
 *
 * Data layout:
 *   V2 topic:      token0 in topic[1], token1 in topic[2], pair in data[0]
 *   Solidly topic: token0 in topic[1], token1 in topic[2], data = [bool stable][address pair]
 */
export async function scanFactoryHyperSync(
    hypersyncUrl: string,
    apiToken: string,
    factory: string,
    fromBlock: number,
    toBlock: number,
    topic: string,
    isSolidly: boolean,
    onBatch: (pairs: ScannedPair[], progressBlock: number) => Promise<void> | void,
    abortSignal?: AbortSignal,
): Promise<{ totalPairs: number; batches: number }> {
    const mod: any = await import('@envio-dev/hypersync-client');
    const HypersyncClient = mod.HypersyncClient;
    if (!HypersyncClient) throw new Error('HypersyncClient not exported by @envio-dev/hypersync-client');

    const clientConfig = { url: hypersyncUrl, apiToken, bearerToken: apiToken };
    const client: any = typeof HypersyncClient.new === 'function'
        ? HypersyncClient.new(clientConfig)
        : new HypersyncClient(clientConfig);

    let query: any = {
        fromBlock,
        toBlock: toBlock + 1,
        logs: [{
            address: [factory.toLowerCase()],
            topics: [[topic]],
        }],
        fieldSelection: {
            log: ['Address', 'BlockNumber', 'Data', 'Topic0', 'Topic1', 'Topic2'],
        },
        joinMode: mod.JoinMode?.JoinNothing ?? 2,
    };

    let totalPairs = 0;
    let batches = 0;

    while (true) {
        if (abortSignal?.aborted) {
            process.stdout.write(`\n  [hypersync] aborted — stopping at block ${query.fromBlock}\n`);
            return { totalPairs, batches };
        }

        const res: any = await client.get(query);
        batches++;
        const logs: any[] = res?.data?.logs ?? [];

        const pairs: ScannedPair[] = [];
        for (const log of logs) {
            const topics: any[] = log.topics ?? [];
            const data: string = log.data ?? log.Data ?? '';
            if (topics.length < 3 || data.length < 66) continue;

            const token0 = '0x' + (topics[1] ?? '').slice(-40);
            const token1 = '0x' + (topics[2] ?? '').slice(-40);
            let pair: string;
            let stable: boolean | null = null;
            if (isSolidly) {
                stable = BigInt('0x' + data.slice(2, 66)) === 1n;
                pair = '0x' + data.slice(66, 130).slice(-40);
            } else {
                pair = '0x' + data.slice(2, 66).slice(-40);
            }
            pairs.push({
                pair,
                token0,
                token1,
                blockNumber: log.blockNumber ?? log.block_number ?? query.fromBlock,
                stable,
            });
        }

        // nextBlock is the block AFTER the last one covered. So the last
        // block actually covered by this batch is nextBlock - 1 (or toBlock
        // if this is the final batch).
        const nextBlock: number | undefined = res?.nextBlock;
        const progressBlock = nextBlock != null
            ? Math.min(toBlock, nextBlock - 1)
            : toBlock;

        await onBatch(pairs, progressBlock);
        totalPairs += pairs.length;

        // Progress display — percent of range covered
        const pct = ((progressBlock - fromBlock) / Math.max(1, toBlock - fromBlock) * 100).toFixed(1).padStart(5);
        process.stdout.write(
            `\r  [hypersync] ${pct}% — ${totalPairs} pairs so far (block ${progressBlock}/${toBlock})`
        );

        // Termination
        if (nextBlock == null) break;
        if (nextBlock >= query.toBlock) break;
        if (nextBlock <= query.fromBlock) {
            process.stdout.write(`\n  [hypersync] nextBlock (${nextBlock}) did not advance — stopping\n`);
            break;
        }
        query = { ...query, fromBlock: nextBlock };
    }
    process.stdout.write('\n');
    return { totalPairs, batches };
}
