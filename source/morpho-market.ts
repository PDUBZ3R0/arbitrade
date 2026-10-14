// -----------------------------------------------------------------------------
// CLI: yarn morpho-market <chain> <morpho> [--min N] [--top N]
//
// Turn ONE Morpho Blue address — Morpho's own deployment, or a settlement layer
// built on it (Longbow on Robinhood Chain) — into a verified, paste-ready
// `flashloan` block for conf/<chain>.json5. The Morpho counterpart of
// `yarn aave-market`.
//
// Morpho Blue's flashLoan(token, assets, data) lends ANY token the contract
// holds, at no fee: every market's loan asset AND every market's collateral
// sits in the one singleton. So the question is not "which reserves are
// flash-enabled" but "what does it hold, and how much". Everything is read from
// the chain:
//
//   1. The address has code, and that code carries flashLoan(address,uint256,
//      bytes) in its dispatcher and calls back onMorphoFlashLoan(uint256,bytes)
//      — the exact callback FlashArbExecutor implements. A wrong address (or a
//      lender with another callback) fails here, before anything is configured.
//   2. balanceOf(morpho) for every token in the DB's tokens table plus the
//      chain's numeraire: what it can lend right now.
//   3. Each holding valued in chain.token through the DEX price graph (the
//      dust filter's), deepest first. Holdings below --min (numeraire units,
//      default 0.05) are left out; so are tokens the graph cannot price.
//   4. Prints the block — provider 'morpho', premium 0 — keeping your other
//      flashloan keys (flashSwap, swapRoots …).
//
// Report-only: it never edits config. Free: eth_calls through Multicall3.
// -----------------------------------------------------------------------------

import { Interface, getAddress, id } from 'ethers';
import { loadChainConfig, dbPath } from './util/config.ts';
import { ArbitradeDB } from './util/db.ts';
import { multicall3 } from './util/multicall.ts';
import { makeProvider } from './util/rpc.ts';
import { buildPriceGraph } from './util/numeraire-price.ts';
import { hasSelector, selectorOf } from './util/bytecode.ts';

const args = process.argv.slice(2);
const [chainArg, morphoArg] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (!chainArg || !morphoArg || !/^0x[0-9a-fA-F]{40}$/.test(morphoArg)) {
    console.error('Usage: yarn morpho-market <chain> <morphoAddress> [--min N] [--top N]');
    console.error('');
    console.error('  Verifies a Morpho Blue singleton on-chain and lists what it can flash-lend');
    console.error('  (every token it holds), printing a paste-ready flashloan block. Report-only.');
    console.error('');
    console.error('  --min N   Leave out holdings worth less than N of chain.token (default 0.05)');
    console.error('  --top N   At most N tokens in the block (default 12)');
    process.exit(1);
}
const minValue = Number(opt('--min') ?? 0.05);
const top = Number(opt('--top') ?? 12);

const cfg = loadChainConfig(chainArg);
const provider = makeProvider(cfg.chain);
const morpho = getAddress(morphoArg);
const fail = (msg: string): never => { console.error(`\n[✗] ${msg}`); process.exit(1); };

console.log(`${cfg.chain.name}: checking Morpho Blue at ${morpho}\n`);

// 1. identity, from the bytecode (PUSH4 <selector>), not from calls that could fail for other reasons
const code = (await provider.getCode(morpho)).toLowerCase();
if (code === '0x') fail(`no contract at ${morpho} — wrong address, or wrong chain`);
const has = (sig: string) => hasSelector(code, selectorOf(sig));
// An OUTGOING call's selector is not in the dispatcher, and compilers encode it
// several ways — PUSH4 then SHL, or (via-IR, as Morpho Blue is built) a
// left-aligned PUSH32 constant. Any byte-aligned occurrence counts.
const hasBytes = (sig: string) => {
    const sel = id(sig).slice(2, 10);
    for (let i = code.indexOf(sel, 2); i >= 0; i = code.indexOf(sel, i + 1)) if (i % 2 === 0) return true;
    return false;
};
if (!has('flashLoan(address,uint256,bytes)')) fail(`${morpho} has no flashLoan(address,uint256,bytes) — not a Morpho Blue singleton`);
console.log(`  [✓] flashLoan(address token, uint256 assets, bytes data) in its dispatcher`);
if (!hasBytes('onMorphoFlashLoan(uint256,bytes)')) fail(`${morpho} does not call onMorphoFlashLoan(uint256,bytes) — FlashArbExecutor's Morpho callback would never run`);
console.log(`  [✓] calls back onMorphoFlashLoan(uint256 assets, bytes data) — FlashArbExecutor's SOURCE_MORPHO callback`);
const morphoish = ['idToMarketParams(bytes32)', 'createMarket((address,address,address,address,uint256))', 'feeRecipient()']
    .filter(has).length;
console.log(morphoish >= 2 ? `  [✓] Morpho Blue market surface present (${morphoish}/3 selectors)` : `  [!] only ${morphoish}/3 Morpho Blue market selectors — a fork; the flash-loan surface above is what matters`);

// 2. what it holds
const db = new ArbitradeDB(dbPath(chainArg));
const tokenRows = db.db.prepare('SELECT address, symbol, decimals FROM tokens WHERE decimals IS NOT NULL').all() as Array<{ address: string; symbol: string | null; decimals: number }>;
const meta = new Map(tokenRows.map(r => [r.address.toLowerCase(), r]));
const numeraire = cfg.chain.token?.toLowerCase();
for (const t of [numeraire, ...(cfg.flashloan?.tokens ?? []).map(t => t.address.toLowerCase())]) {
    if (t && !meta.has(t)) meta.set(t, { address: t, symbol: null, decimals: NaN as any });
}
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const addrs = [...meta.keys()];
const balances = new Map<string, bigint>();
for (let i = 0; i < addrs.length; i += 500) {
    const part = addrs.slice(i, i + 500);
    const res = await multicall3(provider, part.map(a => ({ target: a, allowFailure: true, callData: ERC20.encodeFunctionData('balanceOf', [morpho]) })));
    res.forEach((r, k) => {
        if (!r.success || r.returnData === '0x') return;
        try { const b = ERC20.decodeFunctionResult('balanceOf', r.returnData)[0] as bigint; if (b > 0n) balances.set(part[k], b); } catch { /* not an ERC20 */ }
    });
}
// Fill in symbol/decimals for held tokens the tokens table did not have.
const missing = [...balances.keys()].filter(a => !Number.isFinite(meta.get(a)!.decimals) || !meta.get(a)!.symbol);
if (missing.length) {
    const res = await multicall3(provider, missing.flatMap(a => [
        { target: a, allowFailure: true, callData: ERC20.encodeFunctionData('symbol') },
        { target: a, allowFailure: true, callData: ERC20.encodeFunctionData('decimals') },
    ]));
    missing.forEach((a, k) => {
        const m = meta.get(a)!;
        try { if (!m.symbol && res[2 * k].success) m.symbol = String(ERC20.decodeFunctionResult('symbol', res[2 * k].returnData)[0]); } catch {}
        try { if (!Number.isFinite(m.decimals) && res[2 * k + 1].success) m.decimals = Number(ERC20.decodeFunctionResult('decimals', res[2 * k + 1].returnData)[0]); } catch {}
    });
}
console.log(`  [✓] holds ${balances.size} of ${addrs.length} known token(s)`);

// 3. value in chain.token
if (!numeraire) console.log(`  [!] chain.token is not set — holdings cannot be valued; listing by raw amount`);
const graph = numeraire ? buildPriceGraph(db, numeraire, (a) => meta.get(a.toLowerCase())?.decimals ?? 18) : null;
const priceOf = (a: string): number | null => (graph as any)?.prices?.get(a.toLowerCase())?.price ?? null;
const numSym = numeraire ? (meta.get(numeraire)?.symbol ?? 'numeraire') : '';
const rows = [...balances].map(([a, bal]) => {
    const m = meta.get(a)!;
    const amount = Number(bal) / 10 ** (Number.isFinite(m.decimals) ? m.decimals : 18);
    const p = priceOf(a);
    return { address: getAddress(a), symbol: m.symbol ?? a.slice(0, 10), decimals: m.decimals, amount, value: p != null ? amount * p : null };
}).sort((x, y) => (y.value ?? -1) - (x.value ?? -1));

const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toPrecision(4);
console.log(`\n  ${'token'.padEnd(14)} ${'dec'.padStart(3)}  ${'lendable now'.padStart(14)}  ${`≈ ${numSym}`.padStart(12)}`);
for (const r of rows) {
    console.log(`  ${r.symbol.slice(0, 14).padEnd(14)} ${String(r.decimals).padStart(3)}  ${fmt(r.amount).padStart(14)}  ${(r.value != null ? fmt(r.value) : 'unpriced').padStart(12)}`);
}

// 4. the block
const picked = rows.filter(r => r.value != null && r.value >= minValue && Number.isFinite(r.decimals)).slice(0, top);
const fl = cfg.flashloan as any;
const keep = fl ? Object.entries(fl).filter(([k]) => !['provider', 'pool', 'addressesProvider', 'premium', 'tokens', 'vault', 'morpho'].includes(k)) : [];
const render = (v: unknown): string => typeof v === 'object' && v !== null ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${render(x)}`).join(', ')} }` : typeof v === 'string' ? `'${v}'` : String(v);
console.log(`\nPaste into conf/${cfg.chain.label}.json5 (replacing the flashloan block):\n`);
console.log(`  // Morpho Blue ${morpho} — verified by yarn morpho-market ${new Date().toLocaleDateString('en-CA')}.`);
console.log(`  // Lends any token it holds, free. Tokens: holdings >= ${minValue} ${numSym} at the time, deepest first.`);
console.log(`  flashloan: {`);
console.log(`    provider: 'morpho',`);
console.log(`    morpho: '${morpho}',`);
console.log(`    premium: 0,`);
for (const [k, v] of keep) console.log(`    ${k}: ${render(v)},   // kept from your config`);
console.log(`    tokens: [`);
for (const r of picked) console.log(`      { symbol: '${r.symbol}', address: '${r.address}', decimals: ${r.decimals} },   // ${fmt(r.amount)} lendable`);
console.log(`    ],`);
console.log(`  },`);
if (picked.length === 0) console.log(`\n[!] nothing priced above --min ${minValue} — run yarn reserves ${cfg.chain.label} so the price graph has pools, or lower --min`);
console.log(`\nThen: yarn triangles ${cfg.chain.label} (roots follow flashloan.tokens). The executor must have SOURCE_MORPHO — yarn deploy flasharb ${cfg.chain.label} keeps it current.`);
db.close();
