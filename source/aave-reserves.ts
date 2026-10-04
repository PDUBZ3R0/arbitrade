// -----------------------------------------------------------------------------
// CLI: yarn aave-reserves <chain> [options]
//
// Reports live Aave V3 state for every token in conf/<chain>.json5
// flashloan.tokens: can it be flash-borrowed right now, and how deep is it.
//
// Report-only — never edits config. Prints a paste-ready reordering of
// flashloan.tokens at the end, deepest borrowable first, because triangle
// enumeration assigns each triangle's root by position in that list (see the
// header of util/aave-reserves.ts).
//
//   --json        Machine-readable output instead of the table
//   --order-only  Print just the reordered flashloan.tokens block
//
// Free to run: every call is an eth_call, batched through Multicall3.
// -----------------------------------------------------------------------------

import { JsonRpcProvider } from 'ethers';
import { loadChainConfig } from './util/config.ts';
import { fetchAaveReserves, type AaveReserveState } from './util/aave-reserves.ts';
import { makeProvider } from './util/rpc.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn aave-reserves <chain> [--json] [--order-only]');
    console.error('');
    console.error('  --json        Emit JSON instead of the table');
    console.error('  --order-only  Emit only the reordered flashloan.tokens block');
    process.exit(1);
}
const asJson = args.includes('--json');
const orderOnly = args.includes('--order-only');

const cfg = loadChainConfig(chainArg);
if (!cfg.flashloan) {
    console.error(`No flashloan config for ${cfg.chain.name}.`);
    process.exit(1);
}
if (cfg.flashloan.provider !== 'aave-v3') {
    console.error(`${cfg.chain.name} uses ${cfg.flashloan.provider}, not aave-v3. Nothing to check here.`);
    process.exit(1);
}

const provider = makeProvider(cfg.chain);
const snap = await fetchAaveReserves(provider, cfg);

if (asJson) {
    console.log(JSON.stringify(snap, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    process.exit(0);
}

const fmtUsd = (n: number | null): string => {
    if (n == null) return '       —';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
};
const fmtUnits = (v: bigint | null, decimals: number | null): string => {
    if (v == null) return '—';
    const d = decimals ?? 18;
    const whole = v / 10n ** BigInt(d);
    return whole.toLocaleString();
};

const tokensBlock = (rows: AaveReserveState[]): string => {
    const lines = rows.map(r => [
        '    {',
        `      "symbol": "${r.symbol}",`,
        `      "address": "${r.address}",`,
        `      "decimals": ${r.decimals ?? r.configuredDecimals}`,
        '    }',
    ].join('\n'));
    return `  "tokens": [\n${lines.join(',\n')}\n  ]`;
};

if (orderOnly) {
    console.log(tokensBlock(snap.borrowableByDepth));
    process.exit(0);
}

console.log(`Aave V3 reserves on ${cfg.chain.name} @ block ${snap.blockNumber}`);
console.log(`  pool          ${snap.pool}`);
console.log(`  data provider ${snap.dataProvider ?? '(not resolved — liquidity unavailable)'}`);
console.log(`  price oracle  ${snap.priceOracle ?? '(not resolved — ordering falls back to raw units)'}`);
console.log('');

const hdr = `${'symbol'.padEnd(10)}${'borrowable'.padEnd(12)}${'max loan'.padStart(18)}${'value'.padStart(10)}  flags`;
console.log(hdr);
console.log('-'.repeat(hdr.length + 12));

for (const r of [...snap.borrowableByDepth, ...snap.blocked]) {
    const flags: string[] = [];
    if (r.frozen) flags.push('frozen (still loanable)');
    if (!r.borrowingEnabled) flags.push('borrowing-disabled');
    if (r.decimalsMismatch) flags.push(`DECIMALS MISMATCH: aave=${r.decimals} config=${r.configuredDecimals}`);
    if (r.blockedBy.length) flags.unshift(r.blockedBy.join(' + '));
    if (r.error) flags.push(r.error);

    const mark = r.flashLoanable ? 'yes' : 'NO';
    console.log(
        r.symbol.padEnd(10) +
        mark.padEnd(12) +
        fmtUnits(r.maxFlashLoan, r.decimals).padStart(18) +
        fmtUsd(r.maxFlashLoanUsd).padStart(10) +
        '  ' + flags.join('; ')
    );
}

console.log('');
console.log(`  ${snap.borrowableByDepth.length} borrowable, ${snap.blocked.length} blocked, of ${snap.reserves.length} configured`);

const mismatches = snap.reserves.filter(r => r.decimalsMismatch);
if (mismatches.length) {
    console.log('');
    console.log(`  !! ${mismatches.length} DECIMALS MISMATCH — sizing for these roots is wrong by orders of magnitude:`);
    for (const m of mismatches) {
        console.log(`       ${m.symbol}: aave says ${m.decimals}, conf/${cfg.chain.label}.json5 says ${m.configuredDecimals}`);
    }
}

const thin = snap.borrowableByDepth.filter(r => r.maxFlashLoanUsd != null && r.maxFlashLoanUsd < 10_000);
if (thin.length) {
    console.log('');
    console.log(`  ${thin.length} borrowable but under $10k — these win root slots they can't fund:`);
    console.log(`       ${thin.map(r => `${r.symbol} (${fmtUsd(r.maxFlashLoanUsd)})`).join(', ')}`);
}

console.log('');
console.log('Reordered flashloan.tokens (deepest first). Replace the "tokens" array in');
console.log(`conf/${cfg.chain.label}.json5 with this, then re-run \`yarn triangles ${cfg.chain.label}\`:`);
console.log('');
console.log(tokensBlock(snap.borrowableByDepth));

if (snap.blocked.length) {
    console.log('');
    console.log('Omitted as not currently borrowable (do NOT delete these from your notes —');
    console.log('governance reverses these, and re-running this command will pick them back up):');
    for (const b of snap.blocked) {
        console.log(`  ${b.symbol.padEnd(10)} ${b.address}  (${b.blockedBy.join(' + ')})`);
    }
}
