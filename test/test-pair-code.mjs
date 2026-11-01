// Pair-code classifier: a swap() that asks another contract for its fee (or
// for permission) is a trap, however stock the rest of the pair looks.
//
// Polygon, 2026-10-31: WPOL/DAI 0xd4ba843f has the same functions as a
// QuickSwap pair; its swap() reads fee() from 0xe00b4a22 (300 per mille).
// verify-fees had it at 0.3% and the hot loop reverted "UniswapV2: K" 35 times
// through it. Fixtures are heimdall --skip-resolving decompilations of that
// pair and of QuickSwap pair 0x00008dc7.
//
//   node --experimental-strip-types test/test-pair-code.mjs   (no anvil, no heimdall)

import fs from 'node:fs';
import { classifyPairCode, callsIn, functionsOf } from '../source/util/pair-code.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const fx = (n) => fs.readFileSync(new URL(`./fixtures/pair-code/${n}`, import.meta.url), 'utf8');
const trap = fx('fee-contract-0xd4ba843f.sol');
const stock = fx('quickswap-0x00008dc7.sol');
const show = (r) => `${r.verdict}: ${r.findings.map(f => f.what).join(' | ')}`;

// Insert a line into stock swap() right after the `to` callback.
const CALLBACK = /(address\(arg2\)\.\{ value: store_j ether \}Unresolved_10d1e85c\(var_j\); \/\/ call\n)/;
const withLine = (line) => { if (!CALLBACK.test(stock)) throw new Error('fixture changed'); return stock.replace(CALLBACK, `$1        ${line}\n`); };

console.log('1. the two real pairs');
{
    const swap = functionsOf(stock).find(f => f.selector === '022c0d9f');
    ok(swap && callsIn(swap.body).length === 4, 'stock swap() makes 4 calls: transfer, callback, 2x balanceOf', String(swap && callsIn(swap.body).length));
    const s = classifyPairCode(stock);
    ok(s.verdict === 'ok', 'QuickSwap pair: ok', show(s));
    const t = classifyPairCode(trap);
    ok(t.verdict === 'trap' && t.findings.some(f => /fee\(\) on hard-coded 0xe00b4a221cb17fc31313841880a8bed6d3fcbf08/.test(f.what)),
       'the 30% pair: trap, naming fee() on 0xe00b4a22', show(t));
}

console.log('\n2. other ways a swap() can be rigged');
{
    const r = classifyPairCode(withLine('(bool success, bytes memory ret0) = address(unresolved_c45a0155).Unresolved_cc56b2c5(var_j); // staticcall'));
    ok(r.verdict === 'watch' && /from the factory/.test(r.findings[0].what), 'a fee read from the factory (Solidly getFee): watch', show(r));

    const s = classifyPairCode(withLine('(bool success, bytes memory ret0) = address(store_k).Unresolved_3af32abf(var_j); // staticcall'));
    ok(s.verdict === 'trap' && /isWhitelisted\(address\).*refuse callers/.test(s.findings[0].what), 'a whitelist check on a stored contract: trap', show(s));

    const o = classifyPairCode(withLine('require(address(tx.origin) == address(store_k));'));
    ok(o.verdict === 'trap' && o.findings.some(f => /tx\.origin/.test(f.what)), 'a tx.origin check: trap', show(o));

    const m = classifyPairCode(withLine('require(msg.sender == (address(var_c.length)), "SonicOSPair: FORBIDDEN");'));
    ok(m.verdict === 'trap' && m.findings.some(f => /only one caller/.test(f.what)), 'a router-only swap() (SonicOS): trap', show(m));

    const w = classifyPairCode(withLine('require(storage_map_c[address(msg.sender)]);'));
    ok(w.verdict === 'trap' && w.findings.some(f => /per-address flag/.test(f.what)), 'a whitelist on the caller: trap', show(w));

    const d = classifyPairCode(withLine('(bool success, bytes memory ret0) = address(store_k).Unresolved_00000000(var_j); // delegatecall'));
    ok(d.verdict === 'trap' && /delegatecalls/.test(d.findings[0].what), 'a delegatecall from swap(): trap', show(d));
}

console.log('\n2b. Solidly pairs: their own factory and tokens are compiled in');
{
    // Polygon, 2026-10-31: the first sweep flagged 20 Solidly factories as traps because
    // isPaused() on the pair's own factory and balanceOf on its own tokens read as hard-coded calls.
    const F = '0x1d21db6cde1b18c7e47b0f7f42f4b3f68b9beec9', T0 = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', T1 = '0x69c0fc903cc9054a0ce35c19582707e1d1bfce07';
    const sol = withLine([
        `(bool success, bytes memory ret0) = address(${F}).Unresolved_b187bd26(var_j); // staticcall`,
        `(bool success, bytes memory ret0) = address(${T0}).Unresolved_70a08231(var_j); // staticcall`,
        `(bool success, bytes memory ret0) = address(${T1}).Unresolved_70a08231(var_j); // staticcall`,
        `(bool success, bytes memory ret0) = address(${T0}).Unresolved_08c379a0(var_j); // call`,
    ].join('\n        '));
    const r = classifyPairCode(sol, { factory: F, tokens: [T0, T1] });
    ok(r.verdict === 'watch' && r.findings.length === 1 && /isPaused\(\) from the factory/.test(r.findings[0].what),
       'isPaused() on its own factory: watch; balanceOf on its tokens and Error(string): nothing', show(r));
    const u = classifyPairCode(sol);
    ok(u.verdict === 'trap', 'the same code without knowing its factory and tokens: trap', show(u));
    const pf = classifyPairCode(withLine('(bool success, bytes memory ret0) = address(unresolved_c45a0155 / 0x01).Unresolved_a6ae80e2(var_j); // staticcall'));
    ok(pf.verdict === 'watch' && /swapFee\(address\) from the factory/.test(pf.findings[0].what), 'a packed factory getter is still the factory', show(pf));
}

console.log('\n3. owner controls outside swap()');
{
    const setter = stock + `
    /// @custom:selector    0x34e19907
    /// @custom:signature   Unresolved_34e19907(uint256 arg0) public payable
    function Unresolved_34e19907(uint256 arg0) public payable {
        require(address(msg.sender) == address(store_f));
        store_q = arg0;
    }
`;
    const s = classifyPairCode(setter);
    ok(s.verdict === 'watch' && /0x34e19907/.test(s.findings[0].what), 'an owner-gated setFee: watch', show(s));
    const p = classifyPairCode(stock, { proxy: 'EIP-1967 proxy to 0xabc, admin 0xdef' });
    ok(p.verdict === 'watch' && /upgradeable/.test(p.findings[0].what), 'an upgradeable pair: watch', show(p));
}

console.log('\n4. not a V2 pair');
{
    const v3 = stock.replace(/0x022c0d9f/g, '0x128acb08');
    ok(classifyPairCode(v3).verdict === 'unclassified', 'no V2 swap selector: unclassified, not ok');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PAIR-CODE CHECKS PASS');
process.exit(fails ? 1 : 0);
