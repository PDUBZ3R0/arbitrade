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
// Key facts about the API (verified against v1.4+ docs):
//   - Constructor: `new HypersyncClient({ url, apiToken })` — NOT `.new(...)` (that was Rust convention)
//   - The `apiToken` field name — NOT `bearerToken`
//   - Field selection uses snake_case strings, NOT enum imports
//     (LogField/BlockField enum imports exist but string arrays are simpler)
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

    // Constructor is `new HypersyncClient({ url, apiToken })`.
    // The .new() static factory was removed in newer versions.
    const client = new HypersyncClient({ url: hypersyncUrl, apiToken });

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
            log:   ['address', 'block_number'],
            block: ['number'],
        },
        // Only return the log data, no automatic joining to txns/traces/blocks
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
            // Address is required. Node bindings usually return camelCase
            // (address, blockNumber) but be defensive.
            const addr = log.address ?? log.Address;
            if (!addr) continue;
            const emitter = addr.toLowerCase();
            const blockNum = log.blockNumber ?? log.block_number ?? query.fromBlock;

            const existing = emitters.get(emitter);
            if (existing) {
                existing.pairCreatedCount++;
                if (blockNum > existing.lastBlock) existing.lastBlock = blockNum;
            } else {
                emitters.set(emitter, {
                    address: emitter,
                    topicLabel,
                    pairCreatedCount: 1,
                    firstBlock: blockNum,
                    lastBlock: blockNum,
                });
            }
        }

        process.stdout.write(
            `\r  [hypersync] batch ${batchIndex} — ${emitters.size} unique emitters, ${totalLogs} logs, at block ${query.fromBlock}/${toBlock}`
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
