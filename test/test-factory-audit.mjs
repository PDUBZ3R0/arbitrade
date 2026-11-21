// What find-factories does with a verified candidate (source/util/factory-audit.ts)
// and how it names it (source/util/llama.ts): every verdict's effect on the
// proposal, the entry a candidate resolves to, DefiLlama matching, and pair
// sampling with no pool DB. No chain or network needed.
//
//   node --experimental-strip-types test/test-factory-audit.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asFactory, auditEffect } from '../source/util/factory-audit.ts';
import { buildIndex, identifyDex, loadLlamaIndex } from '../source/util/llama.ts';
import { tokenPairs, openPoolDb } from '../source/util/sample-pairs.ts';
import { withEntryFacts } from '../source/util/find-factories.ts';
import { hypersyncUp } from '../source/util/hypersync.ts';
import http from 'node:http';

let pass = 0, fail = 0;
const ok = (cond, what, got) => {
    if (cond) { pass++; console.log(`  ok   ${what}`); }
    else { fail++; console.log(`  FAIL ${what}${got !== undefined ? `  got ${JSON.stringify(got)}` : ''}`); }
};
const fee = o => ({ status: 'UNKNOWN', detail: '', finalFee: null, source: 'none', assumedFee: 0.003, claude: null, ...o });
const code = (verdict, what) => ({ hash: '0x', note: '', report: { verdict, findings: what ? [{ level: 'trap', what }] : [] } });

console.log('\naudit verdicts');
ok(/30% skim/.test(auditEffect('v2', { code: code('trap', 'a 30% skim'), notes: [] }).hold), 'a trap in the pair code holds it back');
ok(!auditEffect('v2', { code: code('watch'), notes: [] }).hold, 'watch and unclassified code do not');
ok(!auditEffect('v2', { code: code('unclassified'), notes: [] }).hold, 'nor does code heimdall could not read');
ok(auditEffect('v2', { fee: fee({ status: 'NO-SWAP' }), notes: [] }).hold, 'no swap(): held');
ok(auditEffect('v2', { fee: fee({ status: 'NON-CP', detail: 'curve=other' }), notes: [] }).hold, 'not constant-product: held');
ok(auditEffect('v2', { fee: fee({ status: 'CONFLICT', detail: 'a vs b' }), notes: [] }).hold, 'signals that disagree: held');
const fix = auditEffect('v2', { fee: fee({ status: 'MISMATCH', finalFee: 0.0025, source: 'empirical' }), notes: [] });
ok(fix.setFee === 0.0025 && !fix.hold, 'a measured fee corrects the proposal', fix);
ok(auditEffect('v2', { fee: fee({ status: 'MATCH', finalFee: 0.003, source: 'decompile' }), notes: [] }).basis === 'fee confirmed (decompile)', 'a matching fee is recorded');
const nothing = auditEffect('v2', { fee: fee({ status: 'UNKNOWN' }), notes: [] });
ok(!nothing.hold && nothing.setFee == null, 'nothing read: nothing changes', nothing);
ok(auditEffect('v2', { fee: fee({ status: 'MISMATCH', finalFee: 0.01, claude: { feeKind: 'per-pair-storage' } }), notes: [] }).hold, 'a per-pair fee can not be a v2 factory fee');
ok(!auditEffect('solidly', { fee: fee({ status: 'NON-CP' }), notes: [] }).hold, 'a stable curve is normal for solidly');
for (const s of ['UNREADABLE', 'FIX', 'REVIEW']) ok(auditEffect('solidly', { accessor: { status: s, detail: 'x' }, notes: [] }).hold, `fee call ${s}: held for a human`);
ok(!auditEffect('solidly', { accessor: { status: 'OK', detail: 'x' }, notes: [] }).hold, 'fee call OK passes');

console.log('\nproposed entries');
const s = asFactory('solidly', 'K', { address: '0xa' });
ok(s.feeFunction === 'getRealFee' && s.feeDivisor === 1e18 && s.feeTarget === 'factory', 'solidly takes the config.ts defaults', s);
const f = asFactory('v2fee', 'K', { address: '0xa', hasStableFlag: true, feeFunction: 'x', feeDivisor: 100 });
ok(f.hasStableFlag && f.feeFunction === 'x' && f.feeDivisor === 100, 'an entry overrides them', f);

const snip = withEntryFacts('        "K": {\n          address: "0xa",\n          fee: 0.003  // ← UNVERIFIED, check pair swap() source\n        }', { address: '0xa', fee: 0.0025, creator: '0xc', dex: 'Pancake' });
ok(/^ +fee: 0\.0025$/m.test(snip) && !/UNVERIFIED/.test(snip), 'the printed snippet shows the audited fee', snip);
ok(/address: "0xa",\n +creator: "0xc",\n +dex: "Pancake",/.test(snip), 'and the creator and DEX', snip);

console.log('\nDefiLlama');
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const rows = [
    { name: 'Uniswap V2', slug: 'uniswap-v2', category: 'Dexs', chains: ['Base'], module: 'uniswap/index.js', parentProtocol: 'parent#uniswap', tvl: 900 },
    { name: 'Uniswap V3', slug: 'uniswap-v3', category: 'Dexs', chains: ['Base'], module: 'uniswap/v3.js', parentProtocol: 'parent#uniswap', tvl: 1000 },
    { name: 'Tiny Fork', slug: 'tiny-fork', category: 'Dexs', chains: ['Base'], module: 'tiny/index.js', tvl: 1 },
    { name: 'Elsewhere', slug: 'elsewhere', category: 'Dexs', chains: ['Polygon'], module: 'else/index.js', tvl: 5 },
    { name: 'A Lender', slug: 'a-lender', category: 'Lending', chains: ['Base'], module: 'lend/index.js', tvl: 5 },
];
const sources = new Map([['uniswap/index.js', `factory: '${A.toUpperCase().replace('0X', '0x')}'`], ['tiny/index.js', `const f = "${A}"; const g = "${B}"`], ['else/index.js', C], ['lend/index.js', C]]);
const index = buildIndex('Base', rows, sources, 1);
ok(index.protocols.length === 3, 'only DEXes on this chain', index.protocols.map(p => p.name));
ok(identifyDex(index, A)?.name === 'Uniswap V2' && identifyDex(index, A).via === 'adapter', 'an address in two adapters goes to the bigger DEX, any case', identifyDex(index, A));
ok(identifyDex(index, B)?.name === 'Tiny Fork', 'an address found by adapter alone');
ok(identifyDex(index, C) === null, 'adapters of other chains and categories are not read');
ok(identifyDex(index, C, 'uniswap')?.name === 'Uniswap V3' && identifyDex(index, C, 'uniswap').via === 'dexscreener', 'a dexId finds the parent, biggest first', identifyDex(index, C, 'uniswap'));
ok(identifyDex(index, C, 'unknownswap') === null, 'an unknown dexId finds nothing');
ok(identifyDex(index, C, 'uni') === null, 'and a partial name does not match');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-'));
const cache = path.join(dir, 'x', 'llama-dex.json');
fs.mkdirSync(path.dirname(cache));
fs.writeFileSync(cache, JSON.stringify({ ...index, at: 1000 }));
ok((await loadLlamaIndex('Base', cache, 2000))?.protocols.length === 3, 'a fresh cache is used without the network');

console.log('\nsampling');
ok(tokenPairs(['a', 'b', 'c']).length === 3 && tokenPairs(['a']).length === 0, 'each hub pair once');
const missing = path.join(dir, 'none.sqlite');
ok(openPoolDb(missing) === null && !fs.existsSync(missing), 'no DB stays no DB: no empty file left behind');
fs.rmSync(dir, { recursive: true, force: true });

console.log('\nHyperSync preflight');
let asked = 0;
const srv = http.createServer((q, r) => { asked++; if (q.url === '/good/height' || q.url === '/revoked/height') { r.writeHead(200); r.end('{"height":5}'); } else if (q.url === '/good/query') { r.writeHead(200); r.end('x'); } else if (q.url === '/revoked/query') { r.writeHead(403); r.end('{"error":"Your token has been revoked."}'); } else if (q.url === '/hasura/height') { r.writeHead(200); r.end('{"data":1}'); } else { r.writeHead(404); r.end('{}'); } });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const H = `http://127.0.0.1:${srv.address().port}`;
ok(await hypersyncUp(`${H}/good/`, 't') === true, 'a real height answers');
ok(await hypersyncUp(`${H}/revoked`, 't') === false, 'a revoked token is found by a query, not the height');
ok(await hypersyncUp(`${H}/v1/graphql`, 't') === false, 'a 404 does not (opBNB pointed at Hasura)');
ok(await hypersyncUp(`${H}/hasura`, 't') === false, 'nor does a 200 with no height');
ok(await hypersyncUp('http://127.0.0.1:1', 't') === false, 'nor a closed port');
const n = asked;
await hypersyncUp(`${H}/v1/graphql`, 't');
ok(asked === n, 'asked once per URL');
srv.close();

// ---- proxies and wrapped-native backing (util/bytecode.ts) --------------------
console.log('\nresolveCode: the code that really runs');
{
    const { resolveCode, holdsNative, selectorOf } = await import('../source/util/bytecode.ts');
    const IMPL = '0x' + '11'.repeat(20), BEACON = '0x' + '22'.repeat(20);
    const IMPL_CODE = '0x60806040' + '63' + selectorOf('swap(uint256,uint256,address,bytes)');
    const word = a => '0x' + a.slice(2).padStart(64, '0');
    const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
    const fake = ({ codes = {}, slots = {}, calls = {}, balances = {} }) => ({
        getCode: async a => codes[a.toLowerCase()] ?? '0x',
        getStorage: async (a, slot) => slots[`${a.toLowerCase()}:${slot}`] ?? '0x' + '0'.repeat(64),
        call: async ({ to }) => { if (calls[to.toLowerCase()]) return calls[to.toLowerCase()]; throw new Error('missing revert data'); },
        getBalance: async a => { if (a === 'throws') throw new Error('rpc'); return balances[a] ?? 0n; },
    });
    const P = '0x' + '33'.repeat(20);
    const GETTER_PROXY = '0x6080' + '63' + '5c60da1b';   // pushes implementation(), as Katana's V2 pairs do

    let r = await resolveCode(fake({ codes: { [P]: '0x6080' } }), P);
    ok(r.code === '0x6080' && r.kind === null, 'a plain contract stays itself');

    r = await resolveCode(fake({ codes: { [P]: `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`, [IMPL]: IMPL_CODE } }), P);
    ok(r.kind === 'clone' && r.code === IMPL_CODE, 'an EIP-1167 clone');

    r = await resolveCode(fake({ codes: { [P]: '0x6080', [IMPL]: IMPL_CODE }, slots: { [`${P}:${SLOT_IMPL}`]: word(IMPL) } }), P);
    ok(r.kind === 'eip1967' && r.code === IMPL_CODE, 'an EIP-1967 proxy');

    r = await resolveCode(fake({ codes: { [P]: '0x6080', [IMPL]: IMPL_CODE }, slots: { [`${P}:${SLOT_BEACON}`]: word(BEACON) }, calls: { [BEACON]: word(IMPL) } }), P);
    ok(r.kind === 'beacon' && r.code === IMPL_CODE, 'a beacon proxy (Katana V3 pools)');

    r = await resolveCode(fake({ codes: { [P]: GETTER_PROXY, [IMPL]: IMPL_CODE }, calls: { [P]: word(IMPL) } }), P);
    ok(r.kind === 'getter' && r.impl === IMPL && r.code === IMPL_CODE, 'an implementation() getter proxy (Katana V2 pairs)');

    r = await resolveCode(fake({ codes: { [P]: '0x6080' }, calls: { [P]: word(IMPL) } }), P);
    ok(r.kind === null, 'a fallback that answers implementation() without the selector is not a proxy');

    r = await resolveCode(fake({ codes: { [P]: GETTER_PROXY }, calls: { [P]: word(IMPL) } }), P);
    ok(r.code === GETTER_PROXY && r.kind === null, 'an implementation with no code falls back to the proxy');

    r = await resolveCode(fake({}), P);
    ok(r.code === '0x', 'no code stays no code');

    ok(await holdsNative(fake({ balances: { w: 1n } }), 'w') === true, 'a wrapped token holding native counts');
    ok(await holdsNative(fake({}), 'w') === false, 'an empty predeploy does not (Ronin 0x4200…0006)');
    ok(await holdsNative(fake({}), 'throws') === false, 'nor does an RPC failure');
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} ok`);
if (fail) process.exit(1);
console.log('all passed');
