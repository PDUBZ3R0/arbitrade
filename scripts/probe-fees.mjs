// -----------------------------------------------------------------------------
// Find the fee accessor on a factory/pair whose convention we don't know yet.
//
//   node --experimental-strip-types scripts/probe-fees.mjs <chain>
//   node --experimental-strip-types scripts/probe-fees.mjs avalanche --only fldx
//   node --experimental-strip-types scripts/probe-fees.mjs avalanche --rpc https://...
//
// WHY THIS IS NODE AND NOT A cast(1) SCRIPT
//
// The first version of this was bash around `cast call`. Every one of its 30
// calls printed "--", including `getReserves()` on a pair whose reserves the
// pipeline had successfully read moments earlier. The calls were fine; the
// harness was not — `bash script.sh` is non-interactive, so ~/.bashrc is never
// sourced, ~/.foundry/bin is off PATH, and every invocation died with
// "cast: command not found" into a variable that was then thrown away.
//
// So: no external binary (ethers is already a dependency), the RPC comes from
// the chain config that the rest of the pipeline uses, and a failure prints
// WHY. A probe that cannot tell "absent" from "broken" is worse than nothing,
// because it produces a page of confident dashes.
//
// WHAT IT DISTINGUISHES, which matters more than it sounds:
//   no code      — nothing deployed at that address. eth_call to a codeless
//                  address SUCCEEDS returning 0x, which is exactly how a
//                  mis-typed executor address once produced a fake clean
//                  simulation in this project. Checked first, always.
//   reverted     — the function isn't there (or rejected the args).
//   empty (0x)   — call "succeeded" with no return data. Code present but no
//                  matching selector, on contracts with a permissive fallback.
//   a value      — printed raw, then divided by every plausible scale AND
//                  inverted, because Solidly-family contracts sometimes return
//                  a divisor (amountIn -= amountIn / fee) rather than a
//                  numerator.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface } from 'ethers';
import { loadChainConfig } from '../source/util/config.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: node --experimental-strip-types scripts/probe-fees.mjs <chain> [options]');
    console.error('');
    console.error('  --rpc URL        Override the chain config host.');
    console.error('  --only NAME      Probe one target only (substring match on its label).');
    console.error('  --factory ADDR   Ad-hoc target: probe this factory...');
    console.error('  --pair ADDR      ...with this pair. Both required together.');
    process.exit(1);
}
const getStr = (f) => { const i = args.indexOf(f); return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined; };

const cfg = loadChainConfig(chainArg);
const rpc = getStr('--rpc') ?? cfg.chain.host;
const only = getStr('--only')?.toLowerCase();
const adHocF = getStr('--factory'), adHocP = getStr('--pair');

// Targets: label, factory, a pair belonging to it, notes.
// Pair addresses must come from that factory's own PairCreated events.
const TARGETS = adHocF && adHocP
    ? [{ label: 'ad-hoc', factory: adHocF, pair: adHocP, note: '' }]
    : {
        avalanche: [
            { label: 'FldxFactory_634e02eb', factory: '0x634e02eb048eb1b5bddc0cfdc20d34503e9b362d',
              pair: '0x7fe7277fc15be3cb2cacd4562d46d36a9839957c',
              note: 'the blocker — no registered accessor matched. pair is stable=0' },
            { label: 'FldxFactory_634e02eb (stable pair)', factory: '0x634e02eb048eb1b5bddc0cfdc20d34503e9b362d',
              pair: '0x004f0a741166cbd87106402e87daf4716aefbdbb',
              note: 'same factory, stable=1 — fees usually differ by curve' },
            { label: 'Factory_85448bf2', factory: '0x85448bf2f589ab1f56225df5167c63f57758f8c1',
              pair: '0xa07182af0f7fb49b9b1ea48ea8c6bb84283a739c',
              note: 'confirm factory.pairFee(pair); probe reported 0.0030-0.0100' },
            { label: 'HcSwapAvaxFactory_7009b361', factory: '0x7009b3619d5ee60d0665ba27cf85edf95fd8ad01',
              pair: '0x34f2284b2da33c0db1ded9dfe5a900f4a86c22b1',
              note: 'is crossPair a public getter? decides exact 0.003/0.005' },
            { label: 'HcSwapAvaxFactory_8e6f4af0', factory: '0x8e6f4af0b6c26d16febdd6f28fa7c694bd49c6bf',
              pair: '0xce1cf707c3be3c7304cc00ee277f99be3706f2ec', note: '' },
            { label: 'PairFactory_aaa16c01', factory: '0xaaa16c016bf556fcd620328f0759252e29b1ab57',
              pair: '0xaaa3f202babcf7d6493afbc0caee03af9c64f984',
              note: 'pre-flight: config says getFee(bool,bool)/10000, 813 pairs' },
            { label: 'PairFactory_fe926062', factory: '0xfe926062fb99ca5653080d6c14fe945ad68c265c',
              pair: '0x495b296c3fc52283fd9565b421386d36f628d55e',
              note: 'blacklisted pending probe — inherited aaa16c01\'s disproven getFee(bool,bool)' },
            { label: 'PairFactory_ac7b7eac', factory: '0xac7b7eac8310170109301034b8fdb75eca4cc491',
              pair: '0x5a5df1a7d9a35188243115dd9b6ce3b59b7f3a46',
              note: 'blacklisted pending probe — same as fe926062' },
            { label: 'PairFactory_eeee1f1c', factory: '0xeeee1f1c93836b2caf8b9e929cb978c35d46657e',
              pair: '0xdf214f497beca7f550a74ceb89240fb185ce19b4',
              note: 'blacklisted pending probe — same as fe926062' },
            { label: 'BaseV1Factory_c62ca231', factory: '0xc62ca231cd2b0c530c622269da02374134511a36',
              pair: '0xb5a2daf9a1af0a50d5e6489201854830264220fb',
              note: 'pre-flight: config says pair.swapFee()/1e6' },
        ],
    }[chainArg] ?? [];

if (TARGETS.length === 0) {
    console.error(`No built-in targets for "${chainArg}". Pass --factory and --pair.`);
    process.exit(1);
}

const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });

// --- preflight: never probe before the transport is known good -------------
console.log(`chain:  ${cfg.chain.name} (${cfg.chain.id})`);
console.log(`rpc:    ${rpc}`);
try {
    const bn = await provider.getBlockNumber();
    console.log(`block:  ${bn}  (transport OK)`);
} catch (err) {
    console.error(`\n[!] Cannot reach the RPC — every probe below would fail for that reason alone.`);
    console.error(`    ${err.message}`);
    console.error(`    Try --rpc with a different endpoint.`);
    process.exit(1);
}

const codeCache = new Map();
async function hasCode(addr) {
    const k = addr.toLowerCase();
    if (!codeCache.has(k)) {
        try { codeCache.set(k, (await provider.getCode(addr)) !== '0x'); }
        catch { codeCache.set(k, null); }   // null = couldn't tell
    }
    return codeCache.get(k);
}

/** Decode a uint-ish return and show every plausible reading of it. */
function interpret(raw) {
    if (raw === '0x' || raw === '0x0') return 'empty (0x) — no return data';
    let v;
    try { v = BigInt(raw.length > 66 ? '0x' + raw.slice(2, 66) : raw); }
    catch { return `raw ${raw.slice(0, 42)}`; }

    if (v === 0n) return '0  — present but unset (a 0 fee overstates output; treat as unusable)';
    // booleans come back as 0/1
    if (v === 1n) return '1  — true (boolean) or a 1-unit fee';

    const n = Number(v);
    const scales = [['1e3', 1e3], ['1e4', 1e4], ['1e6', 1e6], ['1e18', 1e18]];
    const plausible = scales
        .map(([name, s]) => [name, n / s])
        .filter(([, f]) => f >= 0.00001 && f <= 0.05)
        .map(([name, f]) => `${f.toFixed(6)} @${name}`);
    const inv = 1 / n;
    const invStr = (inv >= 0.00001 && inv <= 0.05) ? `  |  1/${v} = ${inv.toFixed(6)} (Solidly divisor)` : '';
    return `${v}` + (plausible.length ? `  ->  ${plausible.join(', ')}` : '  ->  no scale gives a sane fee') + invStr;
}

/**
 * `kind` matters: a shape check (getReserves/token0/stable) must be decoded as
 * its own type. The first version ran everything through the fee interpreter
 * and cheerfully reported token0() as "546584486846459126461364135121053344201067465379
 * -> no scale gives a sane fee", which is noise dressed up as a finding.
 */
async function probe(label, target, sig, fnName, params, kind = 'fee') {
    const code = await hasCode(target);
    if (code === false) return { label, status: 'no code', detail: `nothing deployed at ${target}` };
    const iface = new Interface([`function ${sig}`]);
    let data;
    try { data = iface.encodeFunctionData(fnName, params); }
    catch (e) { return { label, status: 'bad sig', detail: e.shortMessage ?? e.message }; }
    try {
        const raw = await provider.call({ to: target, data });
        if (kind === 'shape') {
            if (raw === '0x') return { label, status: 'ok', detail: 'empty (0x) — selector absent despite a permissive fallback' };
            let decoded;
            try { decoded = iface.decodeFunctionResult(fnName, raw).map(v => String(v)).join(', '); }
            catch { decoded = raw.slice(0, 42) + '…'; }
            return { label, status: 'ok', detail: decoded };
        }
        return { label, status: 'ok', detail: interpret(raw) };
    } catch (err) {
        const why = err.shortMessage ?? err.reason ?? err.message ?? String(err);
        return { label, status: 'revert', detail: why.replace(/\s+/g, ' ').slice(0, 110) };
    }
}

const PAIR_ZERO_ARG = ['fee', 'swapFee', 'pairFee', 'feeRate', 'getFee', 'stableFee', 'volatileFee'];
const FACTORY_BY_PAIR = ['pairFee', 'getFee', 'getRealFee', 'getPairFee', 'tradingFees', 'getFees', 'fees'];
const FACTORY_BY_BOOL = ['getFee', 'getRealFee', 'pairFee', 'fees'];
const FACTORY_ZERO_ARG = ['volatileFee', 'stableFee', 'fee', 'feeRate', 'getFee'];

for (const t of TARGETS) {
    if (only && !t.label.toLowerCase().includes(only)) continue;
    console.log(`\n${'='.repeat(78)}\n${t.label}${t.note ? `\n  ${t.note}` : ''}`);
    console.log(`  factory ${t.factory}\n  pair    ${t.pair}`);

    const fCode = await hasCode(t.factory), pCode = await hasCode(t.pair);
    console.log(`  code:   factory=${fCode === null ? '?' : fCode} pair=${pCode === null ? '?' : pCode}`);
    if (fCode === false || pCode === false) {
        console.log('  [!] Missing bytecode — stopping here. eth_call to a codeless address returns');
        console.log('      0x SUCCESSFULLY, so probing on would produce confident nonsense.');
        continue;
    }

    const rows = [];
    // Shape sanity FIRST: if these fail the address isn't the pair we think.
    rows.push(await probe('pair.getReserves()', t.pair, 'getReserves() view returns (uint112,uint112,uint32)', 'getReserves', [], 'shape'));
    rows.push(await probe('pair.token0()', t.pair, 'token0() view returns (address)', 'token0', [], 'shape'));
    rows.push(await probe('pair.stable()', t.pair, 'stable() view returns (bool)', 'stable', [], 'shape'));
    rows.push(await probe('pair.crossPair()', t.pair, 'crossPair() view returns (bool)', 'crossPair', [], 'shape'));
    rows.push(await probe('pair.degen()', t.pair, 'degen() view returns (bool)', 'degen', [], 'shape'));
    for (const fn of PAIR_ZERO_ARG)
        rows.push(await probe(`pair.${fn}()`, t.pair, `${fn}() view returns (uint256)`, fn, []));
    for (const fn of FACTORY_BY_PAIR)
        rows.push(await probe(`factory.${fn}(pair)`, t.factory, `${fn}(address) view returns (uint256)`, fn, [t.pair]));
    for (const fn of FACTORY_BY_BOOL) {
        rows.push(await probe(`factory.${fn}(false)`, t.factory, `${fn}(bool) view returns (uint256)`, fn, [false]));
        rows.push(await probe(`factory.${fn}(true)`, t.factory, `${fn}(bool) view returns (uint256)`, fn, [true]));
    }
    rows.push(await probe('factory.getFee(false,false)', t.factory, 'getFee(bool,bool) view returns (uint256)', 'getFee', [false, false]));
    rows.push(await probe('factory.getFee(pair,false)', t.factory, 'getFee(address,bool) view returns (uint256)', 'getFee', [t.pair, false]));
    rows.push(await probe('factory.tradingFees(pair,0x0)', t.factory, 'tradingFees(address,address) view returns (uint256)', 'tradingFees', [t.pair, '0x0000000000000000000000000000000000000000']));
    for (const fn of FACTORY_ZERO_ARG)
        rows.push(await probe(`factory.${fn}()`, t.factory, `${fn}() view returns (uint256)`, fn, []));

    const hits = rows.filter(r => r.status === 'ok');
    const rest = rows.filter(r => r.status !== 'ok');
    for (const r of hits) console.log(`  ANSWERED  ${r.label.padEnd(30)} ${r.detail}`);
    if (hits.length === 0) console.log('  (nothing answered)');
    // Group the failures so one real error isn't lost in 25 identical reverts.
    const byDetail = new Map();
    for (const r of rest) {
        const k = `${r.status}: ${r.detail}`;
        if (!byDetail.has(k)) byDetail.set(k, []);
        byDetail.get(k).push(r.label);
    }
    for (const [k, labels] of byDetail) {
        console.log(`  ${k}`);
        console.log(`      ${labels.length} call(s): ${labels.slice(0, 6).join(', ')}${labels.length > 6 ? ` +${labels.length - 6} more` : ''}`);
    }
}

console.log(`\n${'='.repeat(78)}`);
console.log('If a factory answered nothing but its pair answered getReserves/token0,');
console.log('the pair is real and the fee is simply not exposed by any name tried —');
console.log('which points at a fee hardcoded in swap(). Confirm with:');
console.log(`  yarn verify-fees ${chainArg} --group solidly --claude --show-snippets`);
console.log('and then configure stableFees: { stable, volatile } rather than a lookup.');
provider.destroy();
