// -----------------------------------------------------------------------------
// Discover a contract's deployment block.
//
// Strategy (in order):
//   1. If ETHERSCAN_API_KEY is set, ask the block explorer directly.
//      Works with any RPC, no archive access needed. ~200ms per lookup.
//
//   2. Otherwise, binary-search via eth_getCode at historical blocks.
//      Requires an ARCHIVE RPC (Alchemy paid, QuickNode paid, self-hosted).
//      Most free public RPCs (Ankr free, PublicNode, polygon-rpc.com) prune
//      state and will return "state not available" for old blocks.
//
//   3. If both fail, throw with a clear error explaining the fix options.
//
// You only need this once per factory. The result is cached in the DB and
// re-used on subsequent scans. You can also just hardcode `deployBlock` in
// the per-chain JSON5 config to skip discovery entirely.
// -----------------------------------------------------------------------------

import { JsonRpcProvider } from 'ethers';
import { loadChainConfig } from './config.ts';
import { getContractCreation } from './etherscan.ts';
import { realpathSync } from 'node:fs';

/** Detects the various ways RPCs signal "state at this old block is pruned". */
const ARCHIVE_UNAVAILABLE_RE = /(state.*not available|missing trie node|no historical|historical state|archive|pruned)/i;

export async function discoverDeployBlock(
    provider: JsonRpcProvider,
    address: string,
    opts: { chainId?: number; explorerApiKey?: string } = {},
): Promise<number> {
    // Try explorer API first if we have an API key and chain id
    if (opts.chainId && opts.explorerApiKey) {
        try {
            const result = await getContractCreation(opts.chainId, address, opts.explorerApiKey);
            if (result) return result.blockNumber;
            console.log(`  [i] Explorer had no record of ${address}, falling back to RPC binary search`);
        } catch (err) {
            console.log(`  [!] Explorer lookup failed (${(err as Error).message}), falling back to RPC binary search`);
        }
    }

    // RPC binary search fallback
    return discoverViaBinarySearch(provider, address);
}

async function discoverViaBinarySearch(provider: JsonRpcProvider, address: string): Promise<number> {
    const head = await provider.getBlockNumber();

    // Sanity check: contract must exist at head
    let codeNow: string;
    try {
        codeNow = await provider.getCode(address, head);
    } catch (err) {
        throw wrapRpcError(err, address, head, 'checking contract exists at head');
    }
    if (codeNow === '0x' || codeNow === '') {
        throw new Error(`No code at ${address} on latest block ${head} — wrong address or wrong chain?`);
    }

    // Binary search
    let lo = 0;
    let hi = head;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        let code: string;
        try {
            code = await provider.getCode(address, mid);
        } catch (err) {
            throw wrapRpcError(err, address, mid, 'during binary search');
        }
        if (code === '0x' || code === '') {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

function wrapRpcError(err: unknown, address: string, block: number, when: string): Error {
    const raw = err as any;
    const innerMsg = raw?.error?.message ?? raw?.info?.error?.message ?? '';
    const outerMsg = raw?.message ?? String(err);
    const msg = `${outerMsg} ${innerMsg}`;

    if (ARCHIVE_UNAVAILABLE_RE.test(msg)) {
        return new Error(
            `RPC does not have archive state for block ${block} (needed for deploy-block discovery). ` +
            `Your current RPC prunes historical state, which is normal for free tiers. Options:\n` +
            `  1. Set ETHERSCAN_API_KEY in .env (works with any RPC, unified across chains)\n` +
            `  2. Use an archive-node RPC (Alchemy Growth+, QuickNode paid, or self-hosted Erigon/reth)\n` +
            `  3. Hardcode the deploy block in the config's factory entry:\n` +
            `       "FactoryName": { address: "${address}", deployBlock: <block> }\n` +
            `Underlying error: ${msg.trim().slice(0, 200)}`
        );
    }

    return new Error(`RPC error ${when} for ${address} at block ${block}: ${msg.trim()}`);
}

// -----------------------------------------------------------------------------
// CLI

function isMain(): boolean {
    try {
        const invoked = realpathSync(process.argv[1]);
        const here = import.meta.url.replace(/^file:\/\//, '');
        return invoked === here;
    } catch {
        return false;
    }
}

if (isMain()) {
    const [chainArg, address] = process.argv.slice(2);
    if (!chainArg || !address) {
        console.error('Usage: yarn discover-block <chain> <address>');
        process.exit(1);
    }
    const cfg = loadChainConfig(chainArg);
    const provider = new JsonRpcProvider(cfg.chain.host);
    console.log(`Discovering deployment block of ${address} on ${cfg.chain.name}...`);
    const t0 = Date.now();
    const block = await discoverDeployBlock(provider, address, {
        chainId: cfg.chain.id,
        explorerApiKey: process.env.ETHERSCAN_API_KEY,
    });
    console.log(`Found: block ${block} (in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
