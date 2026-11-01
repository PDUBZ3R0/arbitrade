// TokenProbe must measure a tax that the token sells into the pair during the
// transfer, not blame the pair for it.
//
// Polygon, 2026-11-01: Longinus (LGNS) charges 5% on transfers into QuickSwap
// 0x882df4b0 only. Its fee contract sells the fee through that same pair
// inside transfer(), which syncs the pair before the rest is credited. The
// probe read reserves BEFORE its sell transfer, so it asked for ~5% too much,
// got "UniswapV2: K", filed 0x882df4b0 as pair-rejects and recorded LGNS
// clean through another pair. The hot loop then sold LGNS into 0x882df4b0 and
// reverted InsufficientRepay (195 DAI back for 204 owed).
//
//   1. a token taxed only into one pair, synced mid-transfer → fee-on-transfer,
//      sell 5%, buy 0.
//   2. the same token through an untaxed pair → clean (it isn't a token-wide tax).
//   3. an ordinary 5% transfer tax and a clean token are unchanged.
//
//   npm i -D solc@0.8.24   (one-time)
//   node --experimental-strip-types test/test-probe-sync-tax.mjs   (anvil on PATH; own anvil on 8573)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { probePair } from '../source/util/token-probe.ts';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'TokenProbe.sol': { content: fs.readFileSync(here('../contracts/TokenProbe.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };

const PORT = 8573;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

try {
    const root = await deploy(art.MockToken, 'ROOT', 0);
    const R = await root.getAddress();
    const pairOf = async (t) => {
        const p = await deploy(art.MockPair, R, await t.getAddress(), 30);
        const P = await p.getAddress();
        await send(root.mint(P, E(1e6), ov())); await send(t.mint(P, E(1e6), ov())); await send(p.sync(ov()));
        return P;
    };
    const aave = await deploy(art.MockAavePool, 5);
    await send(root.mint(await aave.getAddress(), E(1e6), ov()));
    const probe = await deploy(art.TokenProbe, await aave.getAddress());
    const PROBE = await probe.getAddress();
    const AMOUNT = E(1000);
    const show = (r) => `(${r.status} ${r.buyTaxBps}/${r.sellTaxBps}: ${r.reason})`;

    const lgns = await deploy(art.MockSyncTaxToken, 'LGNS', 500);
    const taxedPair = await pairOf(lgns), otherPair = await pairOf(lgns);
    await send(lgns.setTaxedPair(taxedPair, ov()));

    console.log('1. taxed into this pair, synced mid-transfer');
    const t = await probePair(provider, PROBE, R, taxedPair, AMOUNT, 200);
    ok(t.status === 'fee-on-transfer' && t.buyTaxBps === 0 && Math.abs(t.sellTaxBps - 500) <= 1,
        'fee-on-transfer, sell 5%, buy 0 (was pair-rejects "K")', show(t));

    console.log('\n2. the same token through an untaxed pair');
    const o = await probePair(provider, PROBE, R, otherPair, AMOUNT, 200);
    ok(o.status === 'clean', 'clean', show(o));

    console.log('\n3. ordinary tokens unchanged');
    const plain = await deploy(art.MockToken, 'TAX', 500), clean = await deploy(art.MockToken, 'CLEAN', 0);
    const p = await probePair(provider, PROBE, R, await pairOf(plain), AMOUNT, 200);
    ok(p.status === 'fee-on-transfer' && Math.abs(p.buyTaxBps - 500) <= 1 && Math.abs(p.sellTaxBps - 500) <= 1, '5% transfer tax → fee-on-transfer 5%/5%', show(p));
    const c = await probePair(provider, PROBE, R, await pairOf(clean), AMOUNT, 200);
    ok(c.status === 'clean', 'clean token → clean', show(c));
} catch (e) {
    console.error(e); fails++;
} finally {
    anvil.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL SYNC-TAX PROBE CHECKS PASS');
process.exit(fails ? 1 : 0);
