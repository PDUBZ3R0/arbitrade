// End-to-end test of FlashArbExecutor against a local EVM.
//
// The point is the cases the OLD executor (precomputed amount0Out/amount1Out)
// could not survive. Each mock pair enforces the real UniswapV2 K check with
// its own fee, so a sizing error reverts here exactly as it would on Polygon.
// Test 5 deliberately lies about the fee to prove the K check is live — without
// it, the passing tests would prove nothing.

import { JsonRpcProvider, Wallet, ContractFactory, Contract, Interface } from 'ethers';
import { readFileSync } from 'fs';

const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
// cacheTimeout -1: anvil instamines, and ethers' default 250ms request cache
// hands back a stale transaction count, so sequential deploys collide on nonce.
const provider = new JsonRpcProvider('http://127.0.0.1:8545', undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);

const deploy = async (name, ...args) => {
    const f = new ContractFactory(art[name].abi, art[name].bytecode, w);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
};

const E = (n) => BigInt(Math.round(n)) * 10n ** 18n;
const ppm = (dec) => Math.round(dec * 1_000_000);
const bps = (dec) => Math.round(dec * 10_000);
const fmt = (v) => (Number(v) / 1e18).toFixed(4);

let pass = 0, fail = 0;
const check = (cond, label, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label} ${extra}`); }
    else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};
// Decode our own custom errors (several carry args, so the selector alone is
// not enough) before falling back to text.
const EXEC_IFACE = new Interface(art.FlashArbExecutor.abi);
const revertName = (e) => {
    for (const d of [e?.data, e?.info?.error?.data, e?.error?.data, e?.revert?.data]) {
        if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) {
            try {
                const p = EXEC_IFACE.parseError(d);
                if (p) return `${p.name}(${p.args.map(String).join(', ')})`;
            } catch { /* not ours */ }
        }
    }
    const s = String(e?.shortMessage ?? e?.message ?? e);
    const m = s.match(/custom error '([^('"]+)/) || s.match(/reverted with reason string '([^']+)'/)
           || s.match(/"([A-Za-z0-9:_ ]+)"/);
    return m ? m[1] : s.slice(0, 110);
};

/** 3-hop cycle ROOT -> A -> B -> ROOT. `edge` scales the closing pool's ROOT side. */
async function setup({ fees = [0.003, 0.003, 0.003], edge = 1.0, taxBps = 0 } = {}) {
    const root = await deploy('MockToken', 'ROOT', 0);
    const a = await deploy('MockToken', 'A', taxBps);
    const b = await deploy('MockToken', 'B', 0);
    const [R, A, B] = [await root.getAddress(), await a.getAddress(), await b.getAddress()];

    const p1 = await deploy('MockPair', R, A, bps(fees[0]));
    const p2 = await deploy('MockPair', A, B, bps(fees[1]));
    const p3 = await deploy('MockPair', B, R, bps(fees[2]));
    const [P1, P2, P3] = [await p1.getAddress(), await p2.getAddress(), await p3.getAddress()];

    await (await root.mint(P1, E(1_000_000))).wait();
    await (await a.mint(P1, E(1_000_000))).wait();
    await (await a.mint(P2, E(1_000_000))).wait();
    await (await b.mint(P2, E(1_000_000))).wait();
    await (await b.mint(P3, E(1_000_000))).wait();
    await (await root.mint(P3, E(1_000_000 * edge))).wait();
    for (const p of [p1, p2, p3]) await (await p.sync()).wait();

    const pool = await deploy('MockAavePool', 5n); // 0.05%
    const POOL = await pool.getAddress();
    await (await root.mint(POOL, E(10_000_000))).wait();

    const exec = await deploy('FlashArbExecutor', POOL);
    const EX = await exec.getAddress();

    const hops = [
        { pair: P1, tokenIn: R, feePpm: ppm(fees[0]), recipient: P2, kind: 0 },
        { pair: P2, tokenIn: A, feePpm: ppm(fees[1]), recipient: P3, kind: 0 },
        { pair: P3, tokenIn: B, feePpm: ppm(fees[2]), recipient: EX, kind: 0 },
    ];
    return { root, a, b, p1, p2, p3, exec, R, A, B, P1, P2, P3, EX, hops };
}

const run = async (s, min = 0n, hops = null) => {
    try { await (await s.exec.executeArb(s.R, E(1000), min, hops ?? s.hops)).wait(); return { ok: true }; }
    catch (e) { return { ok: false, err: revertName(e) }; }
};

console.log('\n1. profitable cycle executes and keeps the profit');
{
    const s = await setup({ edge: 1.05 });
    const r = await run(s);
    const got = await s.root.balanceOf(s.EX);
    check(r.ok && got > 0n, 'profit retained', r.ok ? `+${fmt(got)} ROOT` : r.err);
}

console.log('\n2. mid-flight reserve drift: profit adapts downward, does NOT revert');
{
    // Baseline with nobody trading ahead of us.
    const base = await setup({ edge: 1.05 });
    await run(base);
    const p0 = await base.root.balanceOf(base.EX);

    // Same cycle, but someone moves the closing pool against us first. The
    // off-chain quote is now stale by construction — this is precisely the
    // case the precomputed-amounts executor reverted on.
    const s = await setup({ edge: 1.05 });
    await (await s.b.mint(w.address, E(2_000))).wait();
    await (await s.b.approve(s.P3, E(2_000))).wait();
    await (await s.p3.drift(s.B, E(2_000))).wait();
    const r = await run(s);
    check(r.ok, 'executed against drifted reserves', r.ok ? '' : `reverted: ${r.err}`);
    if (r.ok) {
        const p1 = await s.root.balanceOf(s.EX);
        // Both halves matter: still profitable (absorbed), and strictly worse
        // than baseline (the drift was actually priced in, not ignored).
        check(p1 > 0n && p1 < p0, 'drift was absorbed into the sizing',
            `${fmt(p0)} -> ${fmt(p1)} ROOT`);
    }

    // And a drift big enough to erase the edge must still be refused.
    const big = await setup({ edge: 1.05 });
    await (await big.b.mint(w.address, E(20_000))).wait();
    await (await big.b.approve(big.P3, E(20_000))).wait();
    await (await big.p3.drift(big.B, E(20_000))).wait();
    const rb = await run(big);
    check(!rb.ok && /InsufficientRepay/.test(rb.err ?? ''),
        'drift that erases the edge is refused, not executed at a loss', `(${rb.err})`);
}

console.log('\n3. fee-on-transfer token mid-route: absorbed, does NOT revert');
{
    const s = await setup({ edge: 1.12, taxBps: 300 }); // token A taxes 3%
    const r = await run(s);
    check(r.ok, 'executed through a 3% transfer-tax token', r.ok ? `+${fmt(await s.root.balanceOf(s.EX))} ROOT` : `reverted: ${r.err}`);
}

console.log('\n4. non-default per-pair fees are honoured (0.5% / 0.35% / 1%)');
{
    const s = await setup({ fees: [0.005, 0.0035, 0.01], edge: 1.10 });
    const r = await run(s);
    check(r.ok, 'executed with corrected verify-fees values', r.ok ? '' : `reverted: ${r.err}`);
}

console.log('\n5. WRONG fee still breaks K — proves the K check is real');
{
    const s = await setup({ fees: [0.01, 0.01, 0.01], edge: 1.10 });
    const lying = s.hops.map(h => ({ ...h, feePpm: ppm(0.003) }));
    const r = await run(s, 0n, lying);
    check(!r.ok, 'under-stated fee is rejected by the pair', `(${r.err ?? 'no revert!'})`);
}

console.log('\n6. minProfit is enforced on-chain');
{
    const probe = await setup({ edge: 1.05 });
    await run(probe);
    const achievable = await probe.root.balanceOf(probe.EX);

    const hi = await setup({ edge: 1.05 });
    const rHi = await run(hi, achievable * 2n);
    check(!rHi.ok, 'reverts when profit is below minProfit', `(${rHi.err ?? 'no revert!'})`);

    const lo = await setup({ edge: 1.05 });
    const rLo = await run(lo, achievable / 2n);
    check(rLo.ok, 'executes when profit clears minProfit', rLo.ok ? '' : rLo.err);
}

console.log('\n7. unprofitable cycle reverts rather than losing money');
{
    const s = await setup({ edge: 1.0 }); // balanced: fees guarantee a loss
    const r = await run(s);
    check(!r.ok, 'balanced cycle cannot repay the loan', `(${r.err ?? 'no revert!'})`);
}

console.log('\n8. access control');
{
    const s = await setup({ edge: 1.05 });
    const stranger = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', provider);
    const asStranger = new Contract(s.EX, art.FlashArbExecutor.abi, stranger);
    let r1 = false, e1 = '';
    try { await (await asStranger.executeArb(s.R, E(1000), 0n, s.hops)).wait(); } catch (e) { r1 = true; e1 = revertName(e); }
    check(r1, 'executeArb is owner-only', `(${e1})`);
    let r2 = false, e2 = '';
    try { await (await s.exec.executeOperation(s.R, E(1000), 0n, s.EX, '0x')).wait(); } catch (e) { r2 = true; e2 = revertName(e); }
    check(r2, 'executeOperation rejects non-pool callers', `(${e2})`);
}

console.log('\n9. a 2-hop cycle works on the same code path');
{
    const root = await deploy('MockToken', 'ROOT', 0);
    const a = await deploy('MockToken', 'A', 0);
    const [R, A] = [await root.getAddress(), await a.getAddress()];
    const p1 = await deploy('MockPair', R, A, 30);
    const p2 = await deploy('MockPair', R, A, 30);
    const [P1, P2] = [await p1.getAddress(), await p2.getAddress()];
    await (await root.mint(P1, E(1_000_000))).wait();
    await (await a.mint(P1, E(1_000_000))).wait();
    await (await a.mint(P2, E(1_000_000))).wait();
    await (await root.mint(P2, E(1_150_000))).wait();
    await (await p1.sync()).wait(); await (await p2.sync()).wait();
    const pool = await deploy('MockAavePool', 5n);
    const POOL = await pool.getAddress();
    await (await root.mint(POOL, E(10_000_000))).wait();
    const exec = await deploy('FlashArbExecutor', POOL);
    const EX = await exec.getAddress();
    const hops = [
        { pair: P1, tokenIn: R, feePpm: 3000, recipient: P2, kind: 0 },
        { pair: P2, tokenIn: A, feePpm: 3000, recipient: EX, kind: 0 },
    ];
    let ok = true, err = '';
    try { await (await exec.executeArb(R, E(1000), 0n, hops)).wait(); } catch (e) { ok = false; err = revertName(e); }
    check(ok, '2-hop cycle executes', ok ? `+${fmt(await root.balanceOf(EX))} ROOT` : err);
}

console.log('\n10. ArbExecuted reports the REALISED profit, not the prediction');
{
    // Drifted: the realised profit must be strictly below the undrifted case,
    // and the event must carry the realised number. This is what the ledger
    // records, so it has to be the measured value.
    const base = await setup({ edge: 1.05 });
    await run(base);
    const p0 = await base.root.balanceOf(base.EX);

    const s = await setup({ edge: 1.05 });
    await (await s.b.mint(w.address, E(2_000))).wait();
    await (await s.b.approve(s.P3, E(2_000))).wait();
    await (await s.p3.drift(s.B, E(2_000))).wait();
    const tx = await s.exec.executeArb(s.R, E(1000), 0n, s.hops);
    const rc = await tx.wait();

    let ev = null;
    for (const log of rc.logs) {
        try { const p = EXEC_IFACE.parseLog(log); if (p && p.name === 'ArbExecuted') ev = p; } catch {}
    }
    check(!!ev, 'ArbExecuted emitted');
    if (ev) {
        const onChainProfit = ev.args[3];
        const balance = await s.root.balanceOf(s.EX);
        check(onChainProfit === balance, 'event profit equals the retained balance',
            `${fmt(onChainProfit)} ROOT`);
        check(onChainProfit < p0, 'realised profit is below the undrifted prediction',
            `${fmt(p0)} -> ${fmt(onChainProfit)} ROOT`);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
