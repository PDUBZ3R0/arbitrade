// Fee recovery from real Swap+Sync logs must report a large fee, not drop it.
//
// Polygon, 2026-10-31: WPOL/DAI 0xd4ba843f charges 30% (its fee contract's
// fee() is 300 per mille). recoverFee discarded every sample >= 20% as
// implausible, verify-fees reported the factory as "MATCH 0.003", and the hot
// loop's simulations through that pair reverted "UniswapV2: K" 35 times in
// one 25-minute run.
//
//   node --experimental-strip-types test/test-empirical-fee.mjs   (no anvil)

import { Interface } from 'ethers';
import { recoverFee, summarize, pairSwapsWithSyncs, pickFeeSamplePairs } from '../source/util/empirical-fee.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const I = new Interface([
    'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
    'event Sync(uint112 reserve0, uint112 reserve1)',
]);
const who = '0x' + '1'.repeat(40);

// One token0-in swap through a V2 pair whose K check charges `permille`, as
// the pair would log it: Sync (post-swap reserves), then Swap.
function swapLogs(r0, r1, amountIn, permille, block = 1, tx = '0xaa') {
    const inNet = amountIn * BigInt(1000 - permille);
    const out = inNet * r1 / (r0 * 1000n + inNet);
    const sync = I.encodeEventLog('Sync', [r0 + amountIn, r1 - out]);
    const swap = I.encodeEventLog('Swap', [who, amountIn, 0n, 0n, out, who]);
    return [
        { txHash: tx, logIndex: 0, blockNumber: block, topics: sync.topics, data: sync.data },
        { txHash: tx, logIndex: 1, blockNumber: block, topics: swap.topics, data: swap.data },
    ];
}
// The pair's reserves on 2026-10-31.
const R0 = 74741078187035855348n, R1 = 7440237038317880667n;

console.log('1. a single swap');
{
    const [sync, swap] = swapLogs(R0, R1, 10n ** 17n, 3);
    const f = recoverFee(swap, sync);
    ok(f != null && Math.abs(f - 0.003) < 1e-6, 'a 0.3% swap reads 0.003', String(f));
    const [sync30, swap30] = swapLogs(R0, R1, 10n ** 17n, 300);
    const f30 = recoverFee(swap30, sync30);
    ok(f30 != null && Math.abs(f30 - 0.3) < 1e-6, 'a 30% swap reads 0.3 — not dropped as implausible', String(f30));
}

console.log('\n2. the verdict over the pair\'s history');
{
    const logs = [];
    for (let i = 0; i < 10; i++) logs.push(...swapLogs(R0, R1, 10n ** 16n * BigInt(i + 1), 300, 100 + i, `0x${i}`));
    const samples = pairSwapsWithSyncs(logs).map(({ swap, sync }) => ({ txHash: swap.txHash, blockNumber: swap.blockNumber, fee: recoverFee(swap, sync) }))
        .filter(s => s.fee != null);
    ok(samples.length === 10, 'every swap yields a sample', `${samples.length}/10`);
    const v = summarize(samples);
    ok(v.confidence === 'derived' && Math.abs(v.fee - 0.3) < 1e-6, 'the factory resolves to 0.3, which verify-fees reports as a MISMATCH against 0.003', JSON.stringify(v));
}

console.log('\n3. still refused: readings no fee can produce');
{
    // Output larger than any fee allows (a donation, a rebase): a negative fee past the tolerance.
    const sync = I.encodeEventLog('Sync', [R0 + 10n ** 17n, R1 - 10n ** 17n]);
    const swap = I.encodeEventLog('Swap', [who, 10n ** 17n, 0n, 0n, 10n ** 17n, who]);
    ok(recoverFee({ txHash: '0x', logIndex: 1, blockNumber: 1, ...swap }, { txHash: '0x', logIndex: 0, blockNumber: 1, ...sync }) === null, 'more out than the curve allows is refused');
}

console.log('\n4. taxed tokens: which skew the reading, and which pairs are read');
{
    // A plain transfer tax: the pair receives the net amount and logs it as
    // amountIn, so the reading is exact.
    const net = 10n ** 17n * 9963n / 10000n; // 37 bps taken on the way in
    const [sync, swap] = swapLogs(R0, R1, net, 3);
    ok(Math.abs(recoverFee(swap, sync) - 0.003) < 1e-6, 'a plain 37 bps transfer tax leaves a 0.3% reading exact');

    // A reflection token: the pair's balance grew by `drift` since its last
    // Sync, and swap() counts that drift as part of amountIn. The caller sized
    // its output on the real input only, so the reading comes out high.
    const real = 10n ** 17n, drift = 10n ** 14n;
    const inNet = real * 997n;
    const out = inNet * R1 / (R0 * 1000n + inNet);
    const y = I.encodeEventLog('Sync', [R0 + real + drift, R1 - out]);
    const w = I.encodeEventLog('Swap', [who, real + drift, 0n, 0n, out, who]);
    const f = recoverFee({ txHash: '0x', logIndex: 1, blockNumber: 1, ...w }, { txHash: '0x', logIndex: 0, blockNumber: 1, ...y });
    ok(f > 0.0035, 'a reflection payout on the pair skews a 0.3% pair\'s reading upward', f.toFixed(5));

    const T = (n) => '0x' + String(n).repeat(40);
    const root = T(1), clean = T(2), unprobed = T(3), fot = T(4), honey = T(5), quietTax = T(6);
    const probes = new Map([
        [clean,    { probeStatus: 'clean',           buyTaxBps: 0,  sellTaxBps: 0 }],
        [fot,      { probeStatus: 'fee-on-transfer', buyTaxBps: 37, sellTaxBps: 37 }],
        [honey,    { probeStatus: 'honeypot',        buyTaxBps: null, sellTaxBps: null }],
        [quietTax, { probeStatus: 'untestable',      buyTaxBps: 0,  sellTaxBps: 50 }],
    ]);
    const P = (pair, token0, token1) => ({ pair, token0, token1 });
    // Most active first, as getPairsForFactory returns them: the taxed pairs lead.
    const pairs = [P('fot', fot, root), P('honey', root, honey), P('unprobed', unprobed, root),
                   P('quiet', quietTax, root), P('clean', root, clean), P('roots', root, T(7))];
    const { picked, excluded } = pickFeeSamplePairs(pairs, probes, new Set([root, T(7)]));
    ok(picked.map(p => p.pair).join(',') === 'clean,roots,unprobed',
       'pairs of trusted tokens first, then unprobed, never a flagged token', picked.map(p => p.pair).join(','));
    ok(excluded.map(e => `${e.pair}:${e.why}`).join(',') === 'fot:fee-on-transfer,honey:honeypot,quiet:taxed 0/50 bps',
       'each left-out pair says which token and why', excluded.map(e => `${e.pair}:${e.why}`).join(','));

    // Factory 0x232b5b1f on 2026-10-31: only CBS/USDT0 and HKDT/USDT0, both taxed.
    const only = pickFeeSamplePairs([P('cbs', fot, root), P('hkdt', fot, root)], probes, new Set([root]));
    ok(only.picked.length === 0 && only.excluded.length === 2, 'a factory with only taxed pairs is not measured at all');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL EMPIRICAL-FEE CHECKS PASS');
process.exit(fails ? 1 : 0);
