// Token limits one small probe round trip cannot see, checked by yarn probe on
// every token the trade would have recorded clean (util/token-probe.ts).
//
// Polygon, 2026-11-01, both probed clean and then reverted in the hot loop:
//   - DESTRUCTION (0xc94aa2e1, 0xf1fba12e) refuses any transfer over 0.6% of
//     supply ("ERR3"). The probe moved 0.5% of the root reserve; the hot loop
//     sizes hop 0 up to 15% → "UniswapV2: TRANSFER_FAILED".
//   - CVOL (0x9cd55255) rebases (EIP-1967 proxy → ElasticToken). Its V2 pair
//     resyncs; its Algebra pool can't, held ~0 CVOL, and reverted "TF".
//
//   1. a capped token passes probePair, and transferCapReason catches the cap
//   2. an uncapped token, and a token that refuses even the small size → null
//   3. elastic supply is found directly and behind an EIP-1967 proxy; a plain token is not
//
//   npm i -D solc@0.8.24   (one-time)
//   node --experimental-strip-types test/test-probe-hidden-limits.mjs   (anvil on PATH; own anvil on 8574)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { probePair, transferCapReason, elasticSupplySignature } from '../source/util/token-probe.ts';

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

const PORT = 8574;
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
    // probe.ts sizes: the trade at 0.5% of the root reserve, the cap check at
    // 0.5% and 15% (MAX_INPUT_FRACTION_BPS) of the pair's token balance.
    const small = E(1e6) * 50n / 10_000n, large = E(1e6) * 1500n / 10_000n;

    console.log('1. a token capped at 2% of the pair per transfer');
    const capped = await deploy(art.MockCappedToken, E(20_000));
    const C = await capped.getAddress(), CP = await pairOf(capped);
    const t = await probePair(provider, PROBE, R, CP, E(5000), 200);
    ok(t.status === 'clean', 'probePair alone calls it clean (what happened to DESTRUCTION)', `(${t.status}: ${t.reason})`);
    const why = await transferCapReason(provider, C, CP, PROBE, small, large);
    ok(why === 'ERR3', 'transferCapReason: 0.5% moves, 15% reverts "ERR3"', `(${why})`);

    console.log('\n2. no false alarms');
    const plain = await deploy(art.MockToken, 'PLAIN', 0);
    const PP = await pairOf(plain);
    ok(await transferCapReason(provider, await plain.getAddress(), PP, PROBE, small, large) === null, 'uncapped token → null');
    const tight = await deploy(art.MockCappedToken, E(1));
    const TP = await pairOf(tight);
    ok(await transferCapReason(provider, await tight.getAddress(), TP, PROBE, small, large) === null,
        'small size already refused → null (not a size cap; the probe verdict stands)');

    console.log('\n3. elastic supply');
    const elastic = await deploy(art.MockElasticToken);
    const EL = await elastic.getAddress();
    ok(await elasticSupplySignature(provider, EL) === 'scalingFactor()', 'found in the token itself');
    const proxy = await deploy(art.MockEip1967Proxy, EL);
    const PX = await proxy.getAddress();
    ok(await elasticSupplySignature(provider, PX) === 'scalingFactor()', 'found behind an EIP-1967 proxy (CVOL\'s layout)');
    ok(await elasticSupplySignature(provider, await plain.getAddress()) === null, 'plain token → null');
} catch (e) {
    console.error(e); fails++;
} finally {
    anvil.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL HIDDEN-LIMIT PROBE CHECKS PASS');
process.exit(fails ? 1 : 0);
