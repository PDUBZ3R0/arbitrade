// -----------------------------------------------------------------------------
// CLI: yarn run scan <chain> [--transport rpc|etherscan]
//
// Scans creation events for every configured factory on the given chain and
// stores results in db/<chain>.sqlite: PairCreated for the v2/v2fee/solidly
// groups, PoolCreated for the v3 group (stored as pairs.kind = 'v3'; the
// shape is picked by each entry's poolEvent). Algebra entries are skipped.
// Resumable — killing and restarting picks up where it left off, per factory.
//
// Transports:
//   default    RPC first, fall through to Etherscan V2 when RPC prunes logs
//   --transport rpc         RPC only (fails on pruned RPCs)
//   --transport etherscan   Etherscan V2 only (slower ~5 calls/sec, always works)
// -----------------------------------------------------------------------------

import { loadChainConfig, dbPath } from './util/config.ts';
import { scanChain } from './scanner/pairs.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn run scan <chain-name> [--transport rpc|etherscan]');
    console.error('Example: yarn run scan polygon');
    console.error('Example: yarn run scan polygon --transport etherscan');
    process.exit(1);
}

let forceTransport: 'rpc' | 'etherscan' | undefined;
const tIdx = args.indexOf('--transport');
if (tIdx >= 0) {
    const t = args[tIdx + 1];
    if (t !== 'rpc' && t !== 'etherscan') {
        console.error(`--transport must be 'rpc' or 'etherscan' (got: ${t})`);
        process.exit(1);
    }
    forceTransport = t;
}

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);

console.log(`Scanning ${cfg.chain.currency} (chain id ${cfg.chain.id})`);
console.log(`RPC: ${cfg.chain.host.replace(/\/v2\/[a-zA-Z0-9_-]+/, '/v2/***')}`);
console.log(`DB:  ${dbFile}`);
const byGroup = new Map<string, number>();
for (const f of cfg.factories) byGroup.set(f.group, (byGroup.get(f.group) ?? 0) + 1);
console.log(`Factories configured: ${cfg.factories.length} (${[...byGroup].map(([g, n]) => `${g} ${n}`).join(', ')})`);
if (forceTransport) console.log(`Transport: ${forceTransport} (forced)`);

const t0 = Date.now();
const results = await scanChain(cfg, dbFile, { forceTransport });

console.log('\n' + '─'.repeat(60));
console.log('Scan complete in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
const groupOf = new Map(cfg.factories.map(f => [f.name, f.group]));
for (const [name, n] of Object.entries(results)) {
    console.log(`  ${name}: ${n} new ${groupOf.get(name) === 'v3' ? 'pools (v3)' : 'pairs'}`);
}
