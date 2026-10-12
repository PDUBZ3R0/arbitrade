// -----------------------------------------------------------------------------
// CLI: yarn aave-market <chain> <pool> [--expect-provider <addr>] [--min-usd N]
//
// Turn ONE Aave V3 Pool address — Aave's own, or a fork's (HyperLend, …) —
// into a verified, paste-ready `flashloan` block for conf/<chain>.json5.
//
// Everything except the Pool address is read from the chain, never copied from
// docs: docs drift, forks rename things, and an address transcribed from a
// screenshot is one wrong character away from a contract that does not exist.
//
//   1. The Pool has code, and the AddressesProvider it names says it IS its
//      pool (getPool() round-trips) — a wrong or stale address fails here.
//      --expect-provider cross-checks against a provider address you already
//      have from another source (two independent readings agreeing).
//   2. FLASHLOAN_PREMIUM_TOTAL — the fork's real flash fee, not Aave's 0.05%.
//   3. getReservesList() → every reserve, with symbol and decimals read from
//      the token, then the same live checks as `yarn aave-reserves`: active,
//      not paused, flash loans enabled, and the real ceiling
//      min(aToken.totalSupply, underlying.balanceOf(aToken)), valued by the
//      market's own oracle.
//   4. Prints the block: flash-loanable reserves above --min-usd, deepest
//      first (enumeration roots triangles by position in this list — see
//      util/aave-reserves.ts), and leaves your other flashloan keys alone.
//
// The same block serves liquidations: liq-watch uses flashloan.pool as the
// Aave venue when liquidation.pool is unset, and derives the oracle and data
// provider from it.
//
// Report-only, like aave-reserves and verify-fees: it never edits config.
// Free to run: eth_calls only, batched through Multicall3.
// -----------------------------------------------------------------------------

import { Interface, getAddress } from 'ethers';
import { loadChainConfig, type ChainConfig } from './util/config.ts';
import { fetchAaveReserves } from './util/aave-reserves.ts';
import { multicall3 } from './util/multicall.ts';
import { makeProvider } from './util/rpc.ts';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--json'));
const [chainArg, poolArg] = positional;
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (!chainArg || !poolArg || !/^0x[0-9a-fA-F]{40}$/.test(poolArg)) {
    console.error('Usage: yarn aave-market <chain> <poolAddress> [--expect-provider <addr>] [--min-usd N]');
    console.error('');
    console.error('  Verifies an Aave V3 (or fork) Pool on-chain and prints a paste-ready');
    console.error('  flashloan block for conf/<chain>.json5. Report-only.');
    console.error('');
    console.error('  --expect-provider ADDR  Fail unless the Pool\'s AddressesProvider is ADDR');
    console.error('  --min-usd N             Leave out reserves with less than $N borrowable (default 10000)');
    process.exit(1);
}
const minUsd = Number(opt('--min-usd') ?? 10_000);
const expectProvider = opt('--expect-provider');

const cfg = loadChainConfig(chainArg);
const provider = makeProvider(cfg.chain);
const pool = getAddress(poolArg);

const POOL = new Interface([
    'function ADDRESSES_PROVIDER() view returns (address)',
    'function getReservesList() view returns (address[])',
    'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
]);
const PROVIDER = new Interface(['function getPool() view returns (address)', 'function getMarketId() view returns (string)']);
const ERC20 = new Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

const fail = (msg: string): never => { console.error(`\n[✗] ${msg}`); process.exit(1); };
const call = async (target: string, iface: Interface, fn: string, a: unknown[] = []) => {
    const [r] = await multicall3(provider, [{ target, allowFailure: true, callData: iface.encodeFunctionData(fn, a) }]);
    if (!r?.success || r.returnData === '0x') return null;
    try { return iface.decodeFunctionResult(fn, r.returnData); } catch { return null; }
};

console.log(`${cfg.chain.name}: checking Aave V3 Pool ${pool}\n`);

// 1. identity
if ((await provider.getCode(pool)) === '0x') fail(`no contract at ${pool} — wrong address (or wrong chain)`);
const ap = (await call(pool, POOL, 'ADDRESSES_PROVIDER'))?.[0] as string | undefined;
if (!ap) fail(`${pool} has code but no ADDRESSES_PROVIDER() — not an Aave V3 Pool`);
const back = (await call(ap!, PROVIDER, 'getPool'))?.[0] as string | undefined;
if (!back || getAddress(back) !== pool) fail(`AddressesProvider ${ap} says its pool is ${back ?? '(nothing)'}, not ${pool} — stale or wrong address`);
const marketId = (await call(ap!, PROVIDER, 'getMarketId'))?.[0] as string | undefined;
console.log(`  [✓] Pool has code; AddressesProvider ${ap} confirms it${marketId ? ` (market "${marketId}")` : ''}`);
if (expectProvider) {
    if (getAddress(expectProvider) !== getAddress(ap!)) fail(`AddressesProvider is ${ap}, not the expected ${expectProvider}`);
    console.log(`  [✓] matches --expect-provider`);
}

// 2. flash fee
const premiumRaw = (await call(pool, POOL, 'FLASHLOAN_PREMIUM_TOTAL'))?.[0] as bigint | undefined;
const premium = premiumRaw != null ? Number(premiumRaw) / 10_000 : null;
console.log(premium != null
    ? `  [✓] flash-loan premium ${(premium * 100).toFixed(4)}%  (FLASHLOAN_PREMIUM_TOTAL = ${premiumRaw})`
    : `  [!] FLASHLOAN_PREMIUM_TOTAL unreadable — set premium by hand`);

// 3. reserves
const list = ((await call(pool, POOL, 'getReservesList'))?.[0] as string[] | undefined) ?? fail('getReservesList() failed');
const metaRes = await multicall3(provider, list.flatMap(a => [
    { target: a, allowFailure: true, callData: ERC20.encodeFunctionData('symbol') },
    { target: a, allowFailure: true, callData: ERC20.encodeFunctionData('decimals') },
]));
const tokens = list.map((a, i) => {
    const dec = (r: any, fn: string) => { try { return r?.success ? ERC20.decodeFunctionResult(fn, r.returnData)[0] : null; } catch { return null; } };
    return { symbol: String(dec(metaRes[2 * i], 'symbol') ?? a.slice(0, 10)), address: getAddress(a), decimals: Number(dec(metaRes[2 * i + 1], 'decimals') ?? NaN) };
});
console.log(`  [✓] ${list.length} reserves`);

const probeCfg = { ...cfg, flashloan: { provider: 'aave-v3', pool, addressesProvider: ap, premium: premium ?? 0.0005, tokens: tokens.filter(t => Number.isFinite(t.decimals)) } } as ChainConfig;
const snap = await fetchAaveReserves(provider, probeCfg);

const fmtUsd = (n: number | null) => n == null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
console.log(`\n  ${'reserve'.padEnd(18)} ${'dec'.padStart(3)}  ${'flash?'.padEnd(18)} borrowable now`);
for (const r of [...snap.reserves].sort((x, y) => (y.maxFlashLoanUsd ?? -1) - (x.maxFlashLoanUsd ?? -1))) {
    const flag = r.flashLoanable ? 'yes' : `no (${r.blockedBy.join(', ') || r.error || '?'})`;
    if (r.decimalsMismatch) console.log(`  [!] ${r.symbol}: token says ${r.configuredDecimals} decimals, Aave records ${r.decimals}`);
    console.log(`  ${r.symbol.padEnd(18)} ${String(r.decimals ?? '?').padStart(3)}  ${flag.padEnd(18)} ${fmtUsd(r.maxFlashLoanUsd)}`);
}

// 4. the block
const picked = snap.borrowableByDepth.filter(r => (r.maxFlashLoanUsd ?? 0) >= minUsd && !r.decimalsMismatch);
const fl = cfg.flashloan as any;
const keep = fl ? Object.entries(fl).filter(([k]) => !['provider', 'pool', 'addressesProvider', 'premium', 'tokens', 'vault', 'morpho'].includes(k)) : [];
const render = (v: unknown): string => typeof v === 'object' && v !== null ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${render(x)}`).join(', ')} }` : typeof v === 'string' ? `'${v}'` : String(v);
console.log(`\nPaste into conf/${cfg.chain.label}.json5 (replacing the flashloan block):\n`);
console.log(`  // Aave V3 Pool ${marketId ? `"${marketId}" ` : ''}— verified by yarn aave-market ${new Date().toLocaleDateString('en-CA')}.`);
console.log(`  // Tokens: flash-loanable, >= $${minUsd.toLocaleString()} borrowable at the time, deepest first.`);
console.log(`  flashloan: {`);
console.log(`    provider: 'aave-v3',`);
console.log(`    pool: '${pool}',`);
console.log(`    addressesProvider: '${getAddress(ap!)}',`);
console.log(`    premium: ${premium ?? 0.0005},${premium == null ? '   // ← UNVERIFIED' : ''}`);
for (const [k, v] of keep) console.log(`    ${k}: ${render(v)},   // kept from your config`);
console.log(`    tokens: [`);
for (const r of picked) {
    console.log(`      { symbol: '${r.symbol}', address: '${getAddress(r.address)}', decimals: ${r.decimals} },   // ${fmtUsd(r.maxFlashLoanUsd)}`);
}
console.log(`    ],`);
console.log(`  },`);
if (!cfg.chain.token) {
    const wrapped = snap.reserves.find(r => /^w/i.test(r.symbol) && r.symbol.slice(1).toUpperCase() === String((cfg.chain as any).currency ?? '').toUpperCase());
    console.log(`\n[!] chain.token (the numeraire) is not set — evaluator thresholds and swap roots price against it.`);
    if (wrapped) console.log(`    The wrapped native is a reserve here: token: '${getAddress(wrapped.address)}',   // ${wrapped.symbol}`);
}
console.log(`\nLiquidations use this Pool too (liq-watch reads flashloan.pool when liquidation.pool is unset).`);
