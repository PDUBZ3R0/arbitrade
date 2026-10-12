// -----------------------------------------------------------------------------
// What does this chain's RPC refuse in eth_getLogs?   (diagnostic, read-only)
//
//   node --experimental-strip-types scripts/probe-getlogs.ts <chain> [blocks]
//
// yarn scan's incremental catch-up sends ONE getLogs with every factory address
// (and every creation-event topic) over the blocks since the last scan. When a
// provider refuses that ("Request blocked" from publicnode), this narrows down
// why, with raw HTTP so the status code and body are visible, not ethers'
// paraphrase:
//   - control: eth_blockNumber — fails too → the IP is rate-limited/blocked,
//     nothing about getLogs; wait it out or switch RPC
//   - 1 address, 1 topic over the range → range or getLogs itself refused
//   - growing address counts → the address-list cap, if there is one
//   - all topics vs one → topic-OR lists refused
// Requests are spaced 1.5s apart so the probe does not trip a rate limit itself.
// -----------------------------------------------------------------------------

import { loadChainConfig } from '../source/util/config.ts';
import { TOPIC_BY_LAYOUT } from '../source/util/pool-events.ts';

const [chainArg, blocksArg] = process.argv.slice(2);
if (!chainArg) { console.error('usage: probe-getlogs.ts <chain> [blocks=1200]'); process.exit(1); }
const cfg = loadChainConfig(chainArg);
const url = cfg.chain.host;
const span = Number(blocksArg ?? 1200);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const redact = (u: string) => u.replace(/([?&](key|apikey|token)=)[^&]+/gi, '$1…').replace(/\/[A-Za-z0-9_-]{24,}(\/|$)/, '/…$1');

let id = 0;
async function rpc(method: string, params: unknown[]): Promise<{ http: number; ok: boolean; text: string; result?: any }> {
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
        const text = await r.text();
        let j: any; try { j = JSON.parse(text); } catch { /* not JSON */ }
        const ok = r.ok && j && !j.error;
        return { http: r.status, ok, text: j?.error ? JSON.stringify(j.error) : text, result: j?.result };
    } catch (e) { return { http: 0, ok: false, text: (e as Error).message }; }
}
const show = (label: string, r: Awaited<ReturnType<typeof rpc>>, extra = '') =>
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} HTTP ${r.http}  ${r.ok ? extra : r.text.replace(/\s+/g, ' ').slice(0, 140)}`);

const layout = (f: (typeof cfg.factories)[number]) =>
    f.group === 'solidly' ? (f.poolEvent === 'velodrome' ? 'velodrome' : 'solidly') :
    f.group === 'v3' ? (f.poolEvent === 'tickspacing' ? 'v3ts' : 'v3') :
    f.group === 'algebra' ? 'algebra' : 'v2';
const addrs = cfg.factories.map(f => f.address.toLowerCase());
const allTopics = [...new Set(cfg.factories.map(f => TOPIC_BY_LAYOUT[layout(f)]))];
const v2Topic = TOPIC_BY_LAYOUT.v2;

console.log(`${cfg.chain.name}: probing eth_getLogs at ${redact(url)}  (${addrs.length} factories, ${allTopics.length} topics)\n`);
const bn = await rpc('eth_blockNumber', []);
show('control: eth_blockNumber', bn, bn.ok ? `head ${parseInt(bn.result, 16)}` : '');
if (!bn.ok) {
    console.log('\nThe RPC refuses even eth_blockNumber: this is your IP being rate-limited or blocked, not getLogs.');
    console.log('Wait it out, or point the chain at another RPC (SONIC_RPC=… style env override).');
    process.exit(0);
}
const head = parseInt(bn.result, 16);
const from = (n: number) => '0x' + Math.max(0, n).toString(16);
const range = { fromBlock: from(head - span + 1), toBlock: '0x' + head.toString(16) };

const tries: Array<[string, unknown]> = [
    [`1 address, 1 topic, ${span} blocks`, { ...range, address: addrs[0], topics: [v2Topic] }],
    [`1 address, 1 topic, 100 blocks`, { fromBlock: from(head - 99), toBlock: range.toBlock, address: addrs[0], topics: [v2Topic] }],
    [`1 address, ${allTopics.length} topics (OR)`, { ...range, address: [addrs[0]], topics: [allTopics] }],
];
for (const n of [5, 10, 20, 35, 50, addrs.length].filter((n, i, a) => n <= addrs.length && a.indexOf(n) === i)) {
    tries.push([`${n} addresses, 1 topic`, { ...range, address: addrs.slice(0, n), topics: [v2Topic] }]);
}
tries.push([`${addrs.length} addresses, ${allTopics.length} topics (what scan sends)`, { ...range, address: addrs, topics: [allTopics] }]);

for (const [label, filter] of tries) {
    await sleep(1500);
    const r = await rpc('eth_getLogs', [filter]);
    show(label, r, r.ok ? `${r.result.length} logs` : '');
}
await sleep(1500);
show('control again: eth_blockNumber', await rpc('eth_blockNumber', []));
