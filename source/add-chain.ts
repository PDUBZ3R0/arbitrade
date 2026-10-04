// -----------------------------------------------------------------------------
// CLI: yarn add-chain <chainId> [slug] [options]
//
// Registers a chain end to end, from public data plus a few on-chain probes —
// no hand-copying from chainlist:
//
//   conf/@chains.json5          registry entry: id, name, currency, host (a
//                               probed, working https RPC), ws (a probed wss
//                               endpoint), hypersyncUrl, explorer
//   conf/<slug>.json5           chain config skeleton: wrapped native token,
//                               default thresholds, empty factories, and a
//                               flashloan block for whatever lender the chain has
//   hardhat.config.ts           a network entry (+ <SLUG>_RPC env override)
//   ignition/parameters/<slug>.json   FlashArbModule.aavePool (zero address
//                               when the chain has no Aave)
//
// Re-running on a chain that is already registered fills in what is MISSING
// (e.g. a ws endpoint) and changes nothing else — so it is also the way to
// add websockets to the chains you already have:  yarn add-chain 146
//
// Where the data comes from:
//   chain metadata + RPC list   chainid.network/chains.json (ethereum-lists),
//                               falling back to the same data on GitHub;
//                               chainlist.org/rpcs.json for more RPCs
//   HyperSync support           source/data/hypersync-chains.json, parsed from
//                               Envio's supported-chains page (docs/)
//   Aave V3 markets             docs/AAVE/*.json, confirmed on-chain, token
//                               list read live from Pool.getReservesList()
//   Balancer V2 / Morpho Blue   probed at their canonical addresses
//
// Every RPC is tested (eth_chainId must answer with this chain's id) before it
// is written anywhere; a dead or wrong-chain endpoint is never recorded.
//
// Options:
//   --rpc URL      use this https RPC instead of probing chainlist's
//   --ws URL       use this wss endpoint instead of probing
//   --force        overwrite existing registry fields / regenerate conf/<slug>.json5
//   --dry-run      print what would be written, write nothing
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { JsonRpcProvider, Interface, getAddress } from 'ethers';
import { BALANCER_V2_VAULT } from './util/config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONF = path.join(ROOT, 'conf');
const REGISTRY = path.join(CONF, '@chains.json5');
const HARDHAT = path.join(ROOT, 'hardhat.config.ts');
const IGNITION_PARAMS = path.join(ROOT, 'ignition', 'parameters');
const AAVE_DOCS = path.join(ROOT, 'docs', 'AAVE');
const HYPERSYNC_TABLE = path.join(ROOT, 'source', 'data', 'hypersync-chains.json');

const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';  // Ethereum, Base; elsewhere set by hand
const OP_STACK_WETH = '0x4200000000000000000000000000000000000006';
const ZERO = '0x0000000000000000000000000000000000000000';

// ---- args ----------------------------------------------------------------------

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--rpc', '--ws'].includes(args[i - 1]));
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const chainId = Number(positional[0]);
if (!Number.isInteger(chainId) || chainId <= 0) {
    console.error('Usage: yarn add-chain <chainId> [slug] [--rpc URL] [--ws URL] [--force] [--dry-run]');
    console.error('  e.g. yarn add-chain 4663 robinhood');
    console.error('       yarn add-chain 146            (existing chain: fills in missing fields such as ws)');
    process.exit(1);
}
const force = flag('--force');
const dryRun = flag('--dry-run');

// ---- helpers ---------------------------------------------------------------------

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function fetchJson(url: string, ms = 20_000): Promise<any> {
    const res = await withTimeout(fetch(url, { headers: { 'user-agent': 'arbitrade-add-chain' } }), ms);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
}

type ChainMeta = { name: string; currency: string; rpc: string[]; explorer?: string; shortName?: string };

async function loadChainMeta(id: number): Promise<ChainMeta> {
    let entry: any = null;
    try {
        const all = await fetchJson('https://chainid.network/chains.json', 30_000);
        entry = all.find((c: any) => c.chainId === id) ?? null;
    } catch (e) {
        console.log(`  chainid.network unavailable (${(e as Error).message}) — trying GitHub`);
    }
    if (!entry) {
        try { entry = await fetchJson(`https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains/eip155-${id}.json`); }
        catch { /* fall through */ }
    }
    if (!entry) throw new Error(`chain ${id} not found in ethereum-lists (chainid.network / GitHub)`);

    const rpc = new Set<string>(entry.rpc ?? []);
    try {
        const extra = await fetchJson('https://chainlist.org/rpcs.json', 30_000);
        const c = extra.find((x: any) => x.chainId === id);
        for (const r of c?.rpc ?? []) {
            const url = typeof r === 'string' ? r : r?.url;
            // chainlist marks endpoints that log/track users; skip those.
            if (url && (typeof r === 'string' || r.tracking !== 'yes')) rpc.add(url);
        }
    } catch { /* optional source */ }

    return {
        name: String(entry.name).replace(/\s+mainnet$/i, '').trim(),
        currency: entry.nativeCurrency?.symbol ?? 'ETH',
        rpc: [...rpc],
        explorer: entry.explorers?.[0]?.url,
        shortName: entry.shortName,
    };
}

async function rpcCall(url: string, method: string, params: any[] = [], ms = 6000): Promise<any> {
    const res = await withTimeout(fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }), ms);
    const j: any = await res.json();
    if (j.error) throw new Error(j.error.message ?? 'rpc error');
    return j.result;
}

/** Working https endpoints for this chain, fastest first; publicnode preferred. */
async function probeHttp(urls: string[], id: number): Promise<Array<{ url: string; ms: number }>> {
    const usable = urls.filter(u => /^https:\/\//.test(u) && !/\$\{|API_KEY|YOUR_|<|>/i.test(u));
    const results = await Promise.all(usable.map(async url => {
        const t = Date.now();
        try {
            const cid = await rpcCall(url, 'eth_chainId');
            if (parseInt(cid, 16) !== id) return null;
            await rpcCall(url, 'eth_blockNumber');
            return { url, ms: Date.now() - t };
        } catch { return null; }
    }));
    const ok = results.filter((r): r is { url: string; ms: number } => r !== null);
    return ok.sort((a, b) => (Number(/publicnode/.test(b.url)) - Number(/publicnode/.test(a.url))) || a.ms - b.ms);
}

/** First wss endpoint that answers eth_chainId with this chain's id. */
async function probeWs(urls: string[], id: number): Promise<string | undefined> {
    const WS: any = (globalThis as any).WebSocket;
    if (!WS) { console.log('  (this Node has no global WebSocket — skipping ws probe; pass --ws)'); return undefined; }
    const usable = urls.filter(u => /^wss:\/\//.test(u) && !/\$\{|API_KEY|YOUR_/i.test(u))
        .sort((a, b) => Number(/publicnode/.test(b)) - Number(/publicnode/.test(a)));
    for (const url of usable) {
        const ok = await new Promise<boolean>(resolve => {
            let done = false;
            const finish = (v: boolean) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
            let ws: any;
            try { ws = new WS(url); } catch { return resolve(false); }
            const timer = setTimeout(() => finish(false), 6000);
            ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
            ws.onmessage = (ev: any) => {
                clearTimeout(timer);
                try { finish(parseInt(JSON.parse(String(ev.data)).result, 16) === id); } catch { finish(false); }
            };
            ws.onerror = () => { clearTimeout(timer); finish(false); };
        });
        if (ok) return url;
    }
    return undefined;
}

function hypersyncFor(id: number): string | undefined {
    try {
        const t = JSON.parse(fs.readFileSync(HYPERSYNC_TABLE, 'utf8'));
        const row = t.chains?.[String(id)];
        return row?.hypersync ? `https://${id}.hypersync.xyz` : undefined;
    } catch { return undefined; }
}

function deriveSlug(name: string): string {
    return name.toLowerCase()
        .replace(/\b(mainnet|network)\b/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(mainnet|network|chain)$/g, '');

// ---- on-chain probes ---------------------------------------------------------------

const ERC20 = new Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)',
                             'function balanceOf(address) view returns (uint256)']);
const AAVE = new Interface(['function getReservesList() view returns (address[])', 'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)']);
const BAL = new Interface(['function getProtocolFeesCollector() view returns (address)', 'function getFlashLoanFeePercentage() view returns (uint256)']);

async function call(p: JsonRpcProvider, to: string, iface: Interface, fn: string, a: any[] = []): Promise<any> {
    const raw = await withTimeout(p.call({ to, data: iface.encodeFunctionData(fn, a) }), 10_000);
    return iface.decodeFunctionResult(fn, raw);
}
async function hasCode(p: JsonRpcProvider, a: string): Promise<boolean> {
    try { return (await withTimeout(p.getCode(a), 10_000)) !== '0x'; } catch { return false; }
}
async function tokenInfo(p: JsonRpcProvider, a: string): Promise<{ symbol: string; decimals: number } | null> {
    try {
        const [[symbol], [decimals]] = await Promise.all([call(p, a, ERC20, 'symbol'), call(p, a, ERC20, 'decimals')]);
        return { symbol: String(symbol), decimals: Number(decimals) };
    } catch { return null; }
}

type FlashToken = { symbol: string; address: string; decimals: number };
type AaveFound = { pool: string; premium: number; tokens: FlashToken[]; doc: string; live: boolean };

async function findAave(p: JsonRpcProvider | null, meta: ChainMeta, slug: string): Promise<AaveFound | null> {
    if (!fs.existsSync(AAVE_DOCS)) return null;
    const docs = fs.readdirSync(AAVE_DOCS).filter(f => f.endsWith('.json')).map(f => {
        try { return { file: f, j: JSON5.parse(fs.readFileSync(path.join(AAVE_DOCS, f), 'utf8')) }; }
        catch { return null; }
    }).filter((d): d is { file: string; j: any } => !!d && !!d.j.pool);

    // Name match first ("Avalanche V3 Market.json" ~ "Avalanche C-Chain"), then
    // any doc whose pool actually answers on this chain — several Aave pools
    // share one address across chains, and if it answers here it IS a pool here.
    const names = [meta.name, slug, meta.shortName ?? ''].map(norm).filter(Boolean);
    const docName = (f: string) => norm(f.replace(/\s+V3.*$/i, ''));
    const similar = (n: string, d: string) => n === d || (Math.min(n.length, d.length) >= 3 && (n.startsWith(d) || d.startsWith(n)));
    const byName = docs.filter(d => names.some(n => similar(n, docName(d.file))))
        .sort((a, b) => Number(/core/i.test(b.file)) - Number(/core/i.test(a.file)));
    const ordered = [...byName, ...docs.filter(d => !byName.includes(d))];

    for (const d of ordered) {
        const isNameMatch = byName.includes(d);
        if (!p) {
            if (!isNameMatch) continue;
            return { pool: d.j.pool, premium: d.j.premium, tokens: d.j.tokens, doc: d.file, live: false };
        }
        if (!(await hasCode(p, d.j.pool))) continue;
        let list: string[];
        try { [list] = await call(p, d.j.pool, AAVE, 'getReservesList'); } catch { continue; }
        let premium = d.j.premium ?? 0.0005;
        try { const [bps] = await call(p, d.j.pool, AAVE, 'FLASHLOAN_PREMIUM_TOTAL'); premium = Number(bps) / 10_000; } catch {}
        const tokens: FlashToken[] = [];
        for (const a of list) {
            const t = await tokenInfo(p, a);
            if (t) tokens.push({ symbol: t.symbol, address: getAddress(a), decimals: t.decimals });
        }
        return { pool: getAddress(d.j.pool), premium, tokens, doc: d.file, live: true };
    }
    return null;
}

async function findWrappedNative(p: JsonRpcProvider | null, currency: string, aaveTokens: FlashToken[]): Promise<FlashToken | null> {
    const want = [`W${currency}`.toUpperCase(), currency.toUpperCase() === 'ETH' ? 'WETH' : ''].filter(Boolean);
    const fromAave = aaveTokens.find(t => want.includes(t.symbol.toUpperCase()));
    if (fromAave) return fromAave;
    if (p && await hasCode(p, OP_STACK_WETH)) {
        const t = await tokenInfo(p, OP_STACK_WETH);
        if (t && /^W/i.test(t.symbol) && t.decimals === 18) return { ...t, address: OP_STACK_WETH };
    }
    return null;
}

// ---- file writers ------------------------------------------------------------------

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const keyOf = (slug: string) => /^[a-z_$][a-z0-9_$]*$/i.test(slug) ? slug : q(slug);

type RegEntry = { id: number; name: string; currency: string; hypersyncUrl?: string; host: string; ws?: string; explorer?: string };

function renderRegEntry(slug: string, e: RegEntry): string {
    const lines = [`  ${keyOf(slug)}: {`, `    id: ${e.id},`, `    name: ${q(e.name)},`, `    currency: ${q(e.currency)},`];
    if (e.hypersyncUrl) lines.push(`    hypersyncUrl: ${q(e.hypersyncUrl)},`);
    lines.push(`    host: ${q(e.host)},`);
    if (e.ws) lines.push(`    ws: ${q(e.ws)},`);
    if (e.explorer) lines.push(`    explorer: ${q(e.explorer)},`);
    lines.push('  },');
    return lines.join('\n');
}

/** Text-level edit so comments and formatting in @chains.json5 survive. */
function upsertRegistry(text: string, slug: string, e: RegEntry, existing: Record<string, any>): { text: string; changes: string[] } {
    const keyRe = (k: string) => new RegExp(`^  (?:${k.replace(/[-]/g, '\\-')}|'${k}'|"${k}"):\\s*\\{\\s*$`, 'm');
    const changes: string[] = [];
    if (existing[slug]) {
        const m = keyRe(slug).exec(text);
        if (!m) return { text, changes: [`[!] could not locate "${slug}" block in @chains.json5 — edit by hand`] };
        const start = m.index;
        const end = text.indexOf('\n  },', start);
        let block = text.slice(start, end);
        for (const field of ['hypersyncUrl', 'host', 'ws', 'explorer'] as const) {
            const v = e[field];
            if (!v) continue;
            const has = new RegExp(`^    ${field}:`, 'm').test(block);
            if (has && !force) continue;
            if (has) block = block.replace(new RegExp(`^    ${field}:.*$`, 'm'), `    ${field}: ${q(v)},`);
            else block += `\n    ${field}: ${q(v)},`;
            changes.push(`${has ? 'updated' : 'added'} ${field}`);
        }
        return { text: text.slice(0, start) + block + text.slice(end), changes };
    }
    // Insert in chain-id order, before the first entry with a larger id.
    const next = Object.entries(existing).find(([, v]) => Number(v.id) > e.id);
    const entryText = renderRegEntry(slug, e) + '\n';
    if (next) {
        const m = keyRe(next[0]).exec(text);
        if (m) return { text: text.slice(0, m.index) + entryText + text.slice(m.index), changes: ['added entry'] };
    }
    const close = text.lastIndexOf('}');
    let head = text.slice(0, close).replace(/\s*$/, '\n');
    if (!/,\s*$/.test(head) && /\}\s*$/.test(head)) head = head.replace(/\}\s*$/, '},\n');
    return { text: head + entryText + text.slice(close), changes: ['added entry'] };
}

function renderChainConf(slug: string, id: number, name: string, currency: string, token: FlashToken | null, flash: string): string {
    return `{
  // Generated by \`yarn add-chain ${id}${slug ? ' ' + slug : ''}\`. Registry fields (host, ws,
  // hypersyncUrl) live in @chains.json5; anything set here overrides them.
  chain: {
    id: ${id},
    name: ${q(name)},
    currency: ${q(currency)},
    ${token ? `token: ${q(token.address)},   // ${token.symbol} — the numeraire for thresholds` : `// token: '0x…',   // TODO wrapped native (W${currency}) — not found automatically`}
    // contract: '0x…',  // YoBatches2 — yarn deploy-contract ${slug}
    // executor: '0x…',  // FlashArbExecutor — yarn deploy-flasharb ${slug}
    threads: 10,
    interval: 3000,
    pagesize: 1000000,
  },
  reserves: {
    dust: 0,
  },
  evaluator: {
    // Denominated in chain.token. Tune after the first yarn evaluate.
    minProfitTokens: 0.001,
    minInputTokens: 0.01,
    minLiquidityTokens: 0,
  },
  // yarn find-factories ${slug}, then paste the verified snippets here.
  factories: {
  },
${flash}
}
`;
}

function renderFlash(aave: AaveFound | null, balancer: { fee: number } | null, morpho: boolean, wrapped: FlashToken | null,
                     balancerHeld: string[]): string {
    const tok = (t: FlashToken) => `      { symbol: ${q(t.symbol)}, address: ${q(t.address)}, decimals: ${t.decimals} },`;
    const alt: string[] = [];
    if (aave && balancer) alt.push(`  // Also here: Balancer V2 vault (flash fee ${(balancer.fee * 100).toFixed(3)}%)` +
        (balancerHeld.length ? ` holding ${balancerHeld.join(', ')}. A token can borrow from it instead:` : '.') +
        `\n  //   { symbol: …, address: …, decimals: …, provider: 'balancer-v2' }`);
    if ((aave || balancer) && morpho) alt.push(`  // Also here: Morpho Blue at ${MORPHO_BLUE} (free) — provider: 'morpho', lender: '${MORPHO_BLUE}'.`);
    const altText = alt.length ? alt.join('\n') + '\n' : '';
    if (aave) {
        return `${altText}  // Aave V3 (${aave.doc}${aave.live ? ', reserves read live from the pool' : ', from docs — not confirmed on-chain'}).
  // Order matters: triangle roots are assigned by position — run yarn aave-reserves ${'<slug>'} --order-only.
  flashloan: {
    provider: 'aave-v3',
    premium: ${aave.premium},
    pool: ${q(aave.pool)},
    tokens: [
${aave.tokens.map(tok).join('\n')}
    ],
  },`;
    }
    if (balancer) {
        return `${altText}  // No Aave V3 market here. Balancer V2 vault found (flash fee ${(balancer.fee * 100).toFixed(3)}%).
  // It can only lend what it holds — check before adding tokens.
  flashloan: {
    provider: 'balancer-v2',
    premium: ${balancer.fee},
    vault: ${q(BALANCER_V2_VAULT)},
    tokens: [
${wrapped ? tok(wrapped) : '      // TODO add flash tokens the vault holds'}
    ],
  },`;
    }
    if (morpho) {
        return `  // No Aave V3 or Balancer V2 here. Morpho Blue found — free, lends only what its markets hold.
  flashloan: {
    provider: 'morpho',
    premium: 0,
    morpho: ${q(MORPHO_BLUE)},
    tokens: [
${wrapped ? tok(wrapped) : '      // TODO add flash tokens'}
    ],
  },`;
    }
    return `  // No Aave V3, Balancer V2 or Morpho Blue found. Options:
  //   * a Uniswap V3-style pool's flash(): per token, set provider 'uniswap-v3', lender = the pool
  //     (deep, holds the token, never traded by the cycle) and premium = its fee tier (0.0005 …)
  //   * a Morpho/Balancer deployment at a non-canonical address: provider + morpho/vault here
  flashloan: {
    provider: 'uniswap-v3',
    premium: 0,
    tokens: [
${wrapped ? `      // { symbol: ${q(wrapped.symbol)}, address: ${q(wrapped.address)}, decimals: 18, lender: '0x<V3 pool>', premium: 0.0005 },` : '      // { symbol: …, address: …, decimals: …, lender: \'0x<V3 pool>\', premium: 0.0005 },'}
    ],
  },`;
}

function upsertHardhat(text: string, slug: string, host: string): { text: string; changed: boolean } {
    const netKey = keyOf(slug);
    if (new RegExp(`^\\s{8}${netKey.replace(/[-']/g, m => '\\' + m)}:\\s*\\{`, 'm').test(text)) return { text, changed: false };
    const envName = `${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_RPC`;
    const constLine = `const ${envName.padEnd(13)} = process.env.${envName} || ${q(host)};`;
    const consts = [...text.matchAll(/^const \w+_RPC\s*=.*$/gm)];
    if (consts.length) {
        const last = consts[consts.length - 1];
        const at = last.index! + last[0].length;
        text = text.slice(0, at) + '\n' + constLine + text.slice(at);
    } else {
        text = text.replace(/^(const accounts)/m, `${constLine}\n\n$1`);
    }
    const block = `        ${netKey}: {\n            url: ${envName},\n            accounts,\n            type: "http",\n            chainType: "generic",\n        },\n`;
    const m = /\n    \},\n    solidity:/.exec(text);
    if (!m) throw new Error('hardhat.config.ts: could not find the end of `networks` — add the network by hand');
    text = text.slice(0, m.index + 1) + block + text.slice(m.index + 1);
    return { text, changed: true };
}

// ---- main -----------------------------------------------------------------------------

console.log(`add-chain ${chainId}${positional[1] ? ' ' + positional[1] : ''}${dryRun ? '  (dry run)' : ''}\n`);

const registryText = fs.readFileSync(REGISTRY, 'utf8');
const registry = JSON5.parse(registryText) as Record<string, any>;
const existingLabel = Object.entries(registry).find(([, v]) => Number(v.id) === chainId)?.[0];

console.log('Chain metadata (ethereum-lists / chainlist)...');
const meta = await loadChainMeta(chainId);
const slug = positional[1]?.toLowerCase() ?? existingLabel ?? deriveSlug(meta.name);
if (existingLabel && existingLabel !== slug) {
    console.error(`Chain ${chainId} is already registered as "${existingLabel}". Re-run as: yarn add-chain ${chainId} ${existingLabel}`);
    process.exit(1);
}
if (!existingLabel && registry[slug]) {
    console.error(`Slug "${slug}" is already used by chain ${registry[slug].id}. Pick another: yarn add-chain ${chainId} <slug>`);
    process.exit(1);
}
const displayName = existingLabel ? registry[existingLabel].name : meta.name;
console.log(`  ${displayName} (${meta.currency}), slug "${slug}", ${meta.rpc.length} RPC endpoints listed`);

console.log('Probing RPCs...');
const hostOpt = opt('--rpc');
let host = hostOpt;
if (!host) {
    const working = await probeHttp(meta.rpc, chainId);
    if (working.length) {
        host = working[0].url;
        console.log(`  https: ${working.length} working — using ${host} (${working[0].ms}ms)`);
    } else if (existingLabel) {
        host = registry[existingLabel].host;
        console.log(`  https: none of chainlist's answered; keeping ${host}`);
    } else {
        console.error('  No working https RPC found. Pass one with --rpc URL.');
        process.exit(1);
    }
}
const ws = opt('--ws') ?? await probeWs(meta.rpc, chainId);
console.log(`  wss:   ${ws ?? 'none answered (pass --ws URL to set one)'}`);
const hypersyncUrl = hypersyncFor(chainId);
console.log(`  HyperSync: ${hypersyncUrl ?? 'not listed for this chain'}`);

const provider = new JsonRpcProvider(host, chainId, { staticNetwork: true });
let reachable = true;
try { await withTimeout(provider.getBlockNumber(), 10_000); } catch { reachable = false; console.log('  [!] host did not answer — skipping on-chain probes'); }
const p = reachable ? provider : null;

console.log('Flash-loan sources...');
const aave = await findAave(p, meta, slug);
console.log(`  Aave V3:     ${aave ? `${aave.pool} (${aave.doc}, ${aave.tokens.length} reserves, premium ${(aave.premium * 100).toFixed(3)}%${aave.live ? '' : ', unconfirmed'})` : 'none'}`);
let balancer: { fee: number } | null = null;
if (p && await hasCode(p, BALANCER_V2_VAULT)) {
    let fee = 0;
    try {
        const [collector] = await call(p, BALANCER_V2_VAULT, BAL, 'getProtocolFeesCollector');
        const [pct] = await call(p, collector, BAL, 'getFlashLoanFeePercentage');
        fee = Number(pct) / 1e18;
    } catch { /* collector unreadable: assume the default 0 and say so */ }
    balancer = { fee };
}
console.log(`  Balancer V2: ${balancer ? `vault present, flash fee ${(balancer.fee * 100).toFixed(3)}%` : 'none'}`);
const morpho = !!p && await hasCode(p, MORPHO_BLUE);
console.log(`  Morpho Blue: ${morpho ? 'present (canonical address)' : 'not at the canonical address'}`);

const wrapped = await findWrappedNative(p, meta.currency, aave?.tokens ?? []);
console.log(`  wrapped native: ${wrapped ? `${wrapped.symbol} ${wrapped.address}` : 'not found — set chain.token by hand'}`);

const balancerHeld: string[] = [];
if (p && aave && balancer) {
    for (const t of aave.tokens.slice(0, 25)) {
        try { const [b] = await call(p, BALANCER_V2_VAULT, ERC20, 'balanceOf', [t.address]); if (b > 0n) balancerHeld.push(t.symbol); } catch {}
    }
}

// ---- write ----------------------------------------------------------------------------

const writes: Array<{ file: string; text: string; note: string }> = [];

const reg = upsertRegistry(registryText, slug, {
    id: chainId, name: displayName, currency: existingLabel ? registry[existingLabel].currency : meta.currency,
    hypersyncUrl, host: host!, ws, explorer: meta.explorer,
}, registry);
if (reg.changes.length && reg.text !== registryText) writes.push({ file: REGISTRY, text: reg.text, note: reg.changes.join(', ') });

const confPath = path.join(CONF, `${slug}.json5`);
const flashBlock = renderFlash(aave, balancer, morpho, wrapped, balancerHeld).replace("<slug>", slug);
if (!fs.existsSync(confPath) || force) {
    writes.push({ file: confPath, text: renderChainConf(slug, chainId, displayName, meta.currency, wrapped, flashBlock),
                  note: fs.existsSync(confPath) ? 'regenerated (--force)' : 'created' });
} else {
    console.log(`\nconf/${slug}.json5 exists — left alone (--force regenerates it). Its flashloan block would be:\n${flashBlock}\n`);
}

const hh = fs.readFileSync(HARDHAT, 'utf8');
const hhNew = upsertHardhat(hh, slug, host!);
if (hhNew.changed) writes.push({ file: HARDHAT, text: hhNew.text, note: `network "${slug}"` });

const paramsPath = path.join(IGNITION_PARAMS, `${slug}.json`);
let params: any = {};
try { params = JSON.parse(fs.readFileSync(paramsPath, 'utf8')); } catch {}
if (!params.FlashArbModule?.aavePool || force) {
    params.FlashArbModule = { ...(params.FlashArbModule ?? {}), aavePool: aave?.pool ?? ZERO };
    writes.push({ file: paramsPath, text: JSON.stringify(params, null, 2) + '\n',
                  note: aave ? 'aavePool' : 'aavePool = 0x0 (no Aave: the executor borrows via executeArbFrom)' });
}

console.log('');
for (const w of writes) {
    console.log(`${dryRun ? 'would write' : 'write'}  ${path.relative(ROOT, w.file).padEnd(36)} ${w.note}`);
    if (!dryRun) { fs.mkdirSync(path.dirname(w.file), { recursive: true }); fs.writeFileSync(w.file, w.text); }
}
if (!writes.length) console.log('Nothing to change.');

console.log(`
Next:
  yarn deploy-contract ${slug}        then set chain.contract (YoBatches2)
  yarn deploy-flasharb ${slug}        then set chain.executor
  yarn find-factories ${slug}         paste verified factories into conf/${slug}.json5
  yarn scan ${slug} && yarn tokens ${slug} && yarn reserves ${slug} && yarn triangles ${slug} && yarn evaluate ${slug}`);
if (!aave) console.log(`  [!] No Aave: \`yarn probe\` (TokenProbe) borrows from Aave and will not work on ${slug} yet.`);
provider.destroy();
