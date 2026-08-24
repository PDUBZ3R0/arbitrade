// -----------------------------------------------------------------------------
// CLI: yarn run scan <chain> [--transport rpc|etherscan]
//
// Scans PairCreated events for all V2 factories on the given chain and stores
// results in db/<chain>.sqlite. Resumable — killing and restarting picks up
// where it left off, per factory.
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
console.log(`Factories configured: ${cfg.factories.length}`);
if (forceTransport) console.log(`Transport: ${forceTransport} (forced)`);

const t0 = Date.now();
const results = await scanChain(cfg, dbFile, { forceTransport });

console.log('\n' + '─'.repeat(60));
console.log('Scan complete in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
for (const [name, n] of Object.entries(results)) {
    console.log(`  ${name}: ${n} new pairs`);
}
