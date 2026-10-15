// -----------------------------------------------------------------------------
// CLI: yarn verify-markets <aave-v3|morpho-blue|compound-v3|all> [options]
//
// Checks every address in conf/markets/ on its own chain and prints one
// pass/fail table. The chain does NOT have to be set up in arbitrade: the RPC
// comes from vetted-provider's pool for that chain id (conf/provider/<id>.json
// when rated, chainlist otherwise; <LABEL>_RPC from .env as the private
// fallback).
//
//   aave-v3       Pool has code; its AddressesProvider round-trips getPool();
//                 flash premium, reserves list, price oracle; the configured
//                 addressesProvider / dataProvider match; and whether the
//                 implementation has Aave's liquidationCall — a fork without
//                 it is flash-loan-only for us.
//   morpho-blue   flashLoan in the dispatcher, the onMorphoFlashLoan callback,
//                 the market surface, and liquidate().
//   compound-v3   baseToken, numAssets, getAssetInfo decodes, the base price
//                 feed answers, isLiquidatable answers, absorb/buyCollateral.
//
// The identity checks are util/market-checks.ts — the same ones yarn
// aave-market and yarn morpho-market run before their reserve reports.
//
// Options:
//   --chain 8453,999   only these chain ids
//   --write            also find each missing deployBlock (explorer API when
//                      ETHERSCAN_API_KEY is set, else an archive binary search)
//                      and fill missing Comet names from the base symbol, then
//                      write them back to conf/markets/*.json
//   --verbose          print every finding, not only failures and warnings
//   --concurrency N    chains checked at once (default 4)
//
// Exit status 1 when any market fails. Free: eth_calls and getCode only.
// -----------------------------------------------------------------------------

import { getAddress, type JsonRpcProvider } from 'ethers';
import { PROTOCOLS, loadMarkets, saveMarkets, type Protocol, type MarketBook } from './util/markets.ts';
import { checkAavePool, checkMorpho, checkComet, type Finding } from './util/market-checks.ts';
import { loadChainRegistry } from './util/config.ts';
import { makeProvider } from './util/rpc.ts';
import { discoverDeployBlock } from './util/discover-deploy-block.ts';

const args = process.argv.slice(2);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const flag = (f: string) => args.includes(f);
const which = args[0];
if (!which || (which !== 'all' && !PROTOCOLS.includes(which as Protocol))) {
    console.error(`Usage: yarn verify-markets <${PROTOCOLS.join('|')}|all> [--chain id,id] [--write] [--verbose] [--concurrency N]`);
    process.exit(1);
}
const protocols: Protocol[] = which === 'all' ? [...PROTOCOLS] : [which as Protocol];
const onlyChains = opt('--chain')?.split(',').map(s => Number(s.trim())).filter(Number.isFinite);
const write = flag('--write');
const verbose = flag('--verbose');
const concurrency = Math.max(1, Number(opt('--concurrency') ?? 4));
const CHECK_TIMEOUT_MS = 90_000;

// Registry labels where arbitrade knows the chain, so <LABEL>_RPC applies.
const labelById = new Map<number, string>();
try { for (const m of Object.values(loadChainRegistry())) labelById.set(Number(m.id), m.label); } catch { /* registry unreadable: market-file labels */ }

const books = new Map<Protocol, MarketBook>(protocols.map(p => [p, loadMarkets(p, { fresh: true })]));

type Row = {
    chainId: number; chain: string; protocol: Protocol; name: string; address: string;
    ok: boolean; liquidatable: boolean | null; deployBlock?: number; blockNote?: string;
    findings: Finding[];
};
const rows: Row[] = [];

// Chain id -> every (protocol, market) on it, so each chain gets one provider.
const byChain = new Map<number, Array<{ protocol: Protocol; idx: number }>>();
for (const [p, book] of books) {
    for (const [id, cm] of book) {
        if (onlyChains && !onlyChains.includes(id)) continue;
        cm.markets.forEach((_, idx) => {
            if (!byChain.has(id)) byChain.set(id, []);
            byChain.get(id)!.push({ protocol: p, idx });
        });
    }
}
if (!byChain.size) { console.error('No markets match.'); process.exit(1); }

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
    let t: ReturnType<typeof setTimeout>;
    return Promise.race([
        p.finally(() => clearTimeout(t)),
        new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: no answer in ${ms / 1000}s`)), ms); }),
    ]);
};

async function verifyChain(chainId: number, items: Array<{ protocol: Protocol; idx: number }>): Promise<void> {
    const label = labelById.get(chainId) ?? books.get(items[0].protocol)!.get(chainId)!.chain;
    let provider: JsonRpcProvider | null = null;
    try {
        provider = makeProvider({ id: chainId, label, host: '' });
        const head = await withTimeout(provider.getBlockNumber(), 30_000, 'eth_blockNumber');
        console.log(`  ${label} (${chainId}): head ${head}, ${items.length} market(s)`);
    } catch (e) {
        for (const it of items) {
            const m = books.get(it.protocol)!.get(chainId)!.markets[it.idx];
            rows.push({ chainId, chain: label, protocol: it.protocol, name: m.name ?? '', address: m.address, ok: false, liquidatable: null,
                        deployBlock: m.deployBlock, findings: [{ ok: false, msg: `no working RPC: ${(e as Error).message.slice(0, 120)}` }] });
        }
        try { provider?.destroy(); } catch { /* ignore */ }
        return;
    }
    for (const it of items) {
        const cm = books.get(it.protocol)!.get(chainId)!;
        const m = cm.markets[it.idx];
        const row: Row = { chainId, chain: label, protocol: it.protocol, name: m.name ?? '', address: m.address, ok: false, liquidatable: null, deployBlock: m.deployBlock, findings: [] };
        try {
            const res = await withTimeout(
                it.protocol === 'aave-v3' ? checkAavePool(provider, m.address, { addressesProvider: m.addressesProvider, dataProvider: m.dataProvider })
                : it.protocol === 'morpho-blue' ? checkMorpho(provider, m.address)
                : checkComet(provider, m.address),
                CHECK_TIMEOUT_MS, 'checks');
            row.ok = res.ok;
            row.findings = res.findings;
            row.liquidatable = (res as { liquidatable?: boolean }).liquidatable ?? null;
            if (it.protocol === 'compound-v3' && !m.name && 'baseSymbol' in res && res.baseSymbol && write) {
                m.name = String(res.baseSymbol).toLowerCase();
                row.name = m.name;
                row.blockNote = 'name filled';
            }
        } catch (e) {
            row.findings = [{ ok: false, msg: (e as Error).message.slice(0, 160) }];
        }
        if (write && row.ok && m.deployBlock == null) {
            try {
                const b = await withTimeout(discoverDeployBlock(provider, m.address, { chainId, explorerApiKey: process.env.ETHERSCAN_API_KEY }),
                                            5 * 60_000, 'deploy-block search');
                m.deployBlock = b;
                row.deployBlock = b;
                row.blockNote = row.blockNote ? `${row.blockNote}, block found` : 'block found';
            } catch (e) {
                row.blockNote = `block not found: ${(e as Error).message.split('\n')[0].slice(0, 80)}`;
            }
        }
        rows.push(row);
    }
    try { provider.destroy(); } catch { /* ignore */ }
}

console.log(`verify-markets ${which}: ${[...byChain.values()].reduce((n, v) => n + v.length, 0)} market(s) on ${byChain.size} chain(s)${write ? ' — writing deploy blocks / names back' : ''}\n`);
const queue = [...byChain.entries()].sort((a, b) => a[0] - b[0]);
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await verifyChain(next[0], next[1]);
}));

// ---- report ----------------------------------------------------------------------

rows.sort((a, b) => a.chainId - b.chainId || a.protocol.localeCompare(b.protocol) || a.name.localeCompare(b.name));
const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
console.log(`\n${pad('chain', 22)} ${pad('protocol', 12)} ${pad('name', 12)} ${pad('address', 42)} ${pad('result', 6)} ${pad('liq', 4)} deployBlock`);
for (const r of rows) {
    const warns = r.findings.filter(f => f.warn).length;
    const result = !r.ok ? 'FAIL' : warns ? 'warn' : 'ok';
    const liq = r.liquidatable == null ? '—' : r.liquidatable ? 'yes' : 'no';
    console.log(`${pad(`${r.chain} ${r.chainId}`, 22)} ${pad(r.protocol, 12)} ${pad(r.name || '—', 12)} ${pad(getAddress(r.address), 42)} ${pad(result, 6)} ${pad(liq, 4)} ${r.deployBlock ?? '—'}${r.blockNote ? `  (${r.blockNote})` : ''}`);
    for (const f of r.findings) {
        if (verbose || !f.ok || f.warn) console.log(`${' '.repeat(6)}[${!f.ok ? '✗' : f.warn ? '!' : '✓'}] ${f.msg}`);
    }
}

const failed = rows.filter(r => !r.ok);
const noBlock = rows.filter(r => r.ok && r.deployBlock == null);
console.log(`\n${rows.length - failed.length}/${rows.length} verified, ${failed.length} failed, ${rows.filter(r => r.ok && r.findings.some(f => f.warn)).length} with warnings, ${noBlock.length} without a deployBlock`);
if (noBlock.length && !write) console.log(`  [i] yarn verify-markets ${which} --write   finds the missing deploy blocks and writes them back`);

if (write) {
    for (const [p, book] of books) saveMarkets(p, book);
    console.log(`  wrote ${protocols.map(p => `conf/markets/${p}.json`).join(', ')}`);
}
process.exit(failed.length ? 1 : 0);
