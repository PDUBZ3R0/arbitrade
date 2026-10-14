// -----------------------------------------------------------------------------
// CLI: yarn probe <chain> [options]
//
// Safety sweep: eth_call TokenProbe (contracts/TokenProbe.sol) against every
// token that can appear in a triangle, through its most liquid root pairs.
// Records verdicts in the DB; getPairsForEnumeration() then excludes flagged
// tokens and pairs everywhere downstream (triangles, evaluator, orchestrator).
//
//   token verdicts:  clean | fee-on-transfer | nonstandard | honeypot | dead
//                    untestable (no usable root pair — kept, not excluded)
//   pair verdicts:   ok | pair-restricted (excluded) | pair-rejects (kept)
//
// Free to run: every probe is an eth_call that reverts by design. Requires a
// deployed probe (yarn deploy-probe <chain>) set as chain.probe in config.
//
// Each root is borrowed from the lender the conf gives it (flashTermsFor —
// Aave, Balancer, a V3 pool or Morpho Blue / Longbow), the same lender the
// executor uses. A probe deployed before probeFrom existed can only borrow
// from Aave; roots with any other lender are skipped until it is redeployed.
// -----------------------------------------------------------------------------

import { Interface } from 'ethers';
import { loadChainConfig, dbPath, flashTermsFor } from './util/config.ts';
import { ArbitradeDB } from './util/db.ts';
import { appendToBlacklist } from './util/blacklist.ts';
import { probePair, probeSupportsLenders, STAGE, TOKEN_VERDICTS, type ProbeOutcome, type ProbeLender } from './util/token-probe.ts';
import { makeProvider } from './util/rpc.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn probe <chain> [options]');
    console.error('');
    console.error('  --limit N               Probe at most N tokens this run');
    console.error('  --max-age-days N        Re-probe tokens older than N days (default 7)');
    console.error('  --refresh               Re-probe everything regardless of age');
    console.error('  --concurrency N         Parallel eth_calls (default 8)');
    console.error('  --fee-cap-bps N         Fee assumption for sizing swaps (default 200 = 2%)');
    console.error('  --blacklist-restricted  Append factories whose probed pairs are ALL restricted');
    console.error('                          to conf/<chain>-blacklist.json5');
    console.error('');
    console.error('Afterwards run `yarn triangles <chain>` so the cached triangles drop flagged tokens.');
    process.exit(1);
}
const getNum = (flag: string, dflt: number) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt; };
const hasFlag = (flag: string) => args.includes(flag);

const limit = getNum('--limit', 0) || undefined;
const maxAgeDays = getNum('--max-age-days', 7);
const refresh = hasFlag('--refresh');
const concurrency = Math.max(1, getNum('--concurrency', 8));
const feeCapBps = getNum('--fee-cap-bps', 200);
const blacklistRestricted = hasFlag('--blacklist-restricted');

/** Probe size: this fraction of the root side's reserve (bps). Small enough for minimal price impact, big enough that 1-2 wei rounding doesn't read as a tax. */
const PROBE_SIZE_BPS = 50n; // 0.5%
const PAIRS_PER_TOKEN = 3;
/**
 * How many independent pairs must let us BUY and then refuse to let us SELL
 * before we call the token a honeypot.
 *
 * This verdict lives here, not in classifyRevertData, because one pair cannot
 * support it: a failed exit on a single pair is usually a thin pool, a fee above
 * our feeBpsCap, or a non-constant-product curve. Two independent pairs where
 * the buy leg completed and the sell leg did not is a property of the token.
 *
 * At 1 this collapses back into the bug it replaces (every dust pool becomes a
 * honeypot). Above PAIRS_PER_TOKEN it can never fire.
 */
const HONEYPOT_MIN_FAILED_EXITS = 2;

const cfg = loadChainConfig(chainArg);
if (!cfg.chain.probe) {
    console.error(`No probe deployed for ${cfg.chain.name}. Run \`yarn deploy-probe ${cfg.chain.label}\`, then add`);
    console.error(`  probe: "0x..."  to the chain block of conf/${cfg.chain.label}.json5`);
    process.exit(1);
}
const configured = (cfg.flashloan?.tokens ?? []).map(t => ({ address: t.address.toLowerCase(), symbol: t.symbol ?? t.address.slice(0, 10) }));
if (configured.length === 0) {
    console.error(`No flashloan.tokens configured for ${cfg.chain.name}.`);
    process.exit(1);
}
const allowedFactories = cfg.factories.map(f => f.address.toLowerCase());
const factoryName = new Map(cfg.factories.map(f => [f.address.toLowerCase(), f.name]));

const db = new ArbitradeDB(dbPath(chainArg));
const provider = makeProvider(cfg.chain);

// Where each root is borrowed from, and how much that lender can lend.
const anyLender = await probeSupportsLenders(provider, cfg.chain.probe);
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)']);
const AAVE = new Interface(['function getReserveData(address asset)']);
const lenderOf = new Map<string, { via: ProbeLender | undefined; label: string; cap: bigint | null }>();
for (const t of configured) {
    const terms = flashTermsFor(cfg, t.address);
    if (!terms) { console.log(`  [!] ${t.symbol}: no usable lender in flashloan (uniswap-v3 needs a premium) — not used as a root`); continue; }
    if (!anyLender && terms.provider !== 'aave-v3') {
        console.log(`  [!] ${t.symbol}: lender is ${terms.provider}, but the TokenProbe at ${cfg.chain.probe} only borrows from Aave — redeploy it: yarn deploy probe ${cfg.chain.label}`);
        continue;
    }
    // What the lender can actually lend: Morpho / Balancer / a V3 pool hold
    // the token themselves; Aave holds it in the reserve's aToken. Without the
    // cap a probe sized from a deep pair asks for more than the lender has and
    // dies inside the loan ("ERC20: transfer amount exceeds balance" — Sonic,
    // 2026-10-13), which reads as an RPC error and is retried forever.
    let cap: bigint | null = null;
    try {
        let holder = terms.lender;
        if (terms.provider === 'aave-v3') {
            // getReserveData(asset) — aTokenAddress is word 8 of the (legacy-layout) struct.
            const rd = await provider.call({ to: terms.lender, data: AAVE.encodeFunctionData('getReserveData', [t.address]) });
            holder = '0x' + rd.slice(2 + 8 * 64 + 24, 2 + 9 * 64);
        }
        const raw = await provider.call({ to: t.address, data: ERC20.encodeFunctionData('balanceOf', [holder]) });
        cap = (ERC20.decodeFunctionResult('balanceOf', raw)[0] as bigint) * 9n / 10n;
    } catch { cap = null; }
    // An old probe borrows through probe(), from the Aave pool it was deployed with.
    lenderOf.set(t.address, { via: anyLender ? { source: terms.source, lender: terms.lender } : undefined, label: `${terms.provider} ${terms.lender.slice(0, 10)}`, cap });
}
const roots = [...lenderOf.keys()];
if (roots.length === 0) {
    console.error(`\nNo root can be borrowed by this probe on ${cfg.chain.name}.`);
    if (!anyLender) console.error(`Redeploy it so it can use your flashloan lender: yarn deploy probe ${cfg.chain.label}`);
    process.exit(1);
}

const tokens = db.getTokensToProbe(roots, { maxAgeSeconds: maxAgeDays * 86_400, refresh, limit });
console.log(`Probing ${tokens.length} token(s) on ${cfg.chain.name} via TokenProbe ${cfg.chain.probe}`);
console.log(`  up to ${PAIRS_PER_TOKEN} root pairs each, ${Number(PROBE_SIZE_BPS) / 100}% of root reserve, fee cap ${feeCapBps} bps, concurrency ${concurrency}`);
for (const t of configured) {
    const l = lenderOf.get(t.address);
    if (l) console.log(`  root ${t.symbol.padEnd(10)} borrowed from ${l.label}${l.cap != null ? ` (lends up to ${l.cap} raw)` : ''}`);
}
console.log('');

const counts: Record<string, number> = {};
const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
const flagged: Array<{ token: string; out: ProbeOutcome; pair: string }> = [];
let done = 0;
let rpcErrors = 0;
/** The reasons behind 'error' outcomes — printed, so "retry next run" is not a mystery. */
const errorSamples: string[] = [];

async function probeToken(token: string): Promise<void> {
    const candidates = db.getRootPairsForToken(token, roots, allowedFactories, PAIRS_PER_TOKEN);
    if (candidates.length === 0) {
        db.setTokenProbe(token, { status: 'untestable', buyTaxBps: null, sellTaxBps: null, reason: 'no live, non-restricted root pair in an allowed factory', pair: null });
        bump('untestable');
        return;
    }

    let pairLevelOnly = true;
    let lastReason = '';
    // Pairs where the buy leg completed and the sell leg then failed. Counted
    // across all candidates because that is the only level at which "cannot
    // exit" can be distinguished from "that one pool was too thin to trade".
    let boughtButCouldNotSell = 0;
    let lastFailedExitReason = '';
    for (const c of candidates) {
        const lender = lenderOf.get(c.root.toLowerCase())!;
        let amount = (BigInt(c.rootReserve) * PROBE_SIZE_BPS) / 10_000n;
        // Morpho / Balancer / a V3 pool lend only what they hold.
        if (lender.cap != null && amount > lender.cap) amount = lender.cap;
        if (amount === 0n) continue;
        const out = await probePair(provider, cfg.chain.probe!, c.root, c.pair, amount, feeCapBps, lender.via);
        lastReason = out.reason;

        if (out.status === 'pair-restricted' || out.status === 'pair-rejects') {
            db.setPairProbe(c.pair, out.status, out.reason);
            // Reaching stage 3+ means the buy leg executed: we acquired the
            // token and the pair is tradeable inbound. Failing after that is
            // the half of the honeypot signature we can observe per-pair.
            if (out.stage !== null && out.stage >= STAGE.SELL_TRANSFER) {
                boughtButCouldNotSell++;
                lastFailedExitReason = out.reason;
            }
            continue; // a bad pair says nothing about the token — try the next one
        }
        if (out.status === 'error') {
            pairLevelOnly = false;
            rpcErrors++;
            if (errorSamples.length < 10) errorSamples.push(`${token} via ${c.pair}: ${out.reason.slice(0, 140)}`);
            continue;
        }

        // Token-level verdict. The buy leg executed unless it failed at stage 2
        // (a token refusing transfers to contracts), so the pair itself is fine.
        if (out.stage === null || out.stage >= STAGE.SELL_TRANSFER) db.setPairProbe(c.pair, 'ok', 'round trip reached the sell leg');
        db.setTokenProbe(token, { status: out.status, buyTaxBps: out.buyTaxBps, sellTaxBps: out.sellTaxBps, reason: out.reason, pair: c.pair });
        bump(out.status);
        if (out.status !== 'clean') flagged.push({ token, out, pair: c.pair });
        return;
    }

    // Cross-pair verdict, checked before 'untestable': we bought this token on
    // several independent pairs and could not sell it back on any of them. That
    // is the honeypot signature, and it is only visible from here.
    if (boughtButCouldNotSell >= HONEYPOT_MIN_FAILED_EXITS) {
        const reason = `bought on ${boughtButCouldNotSell} independent pairs, could not exit any (last: ${lastFailedExitReason})`;
        db.setTokenProbe(token, { status: 'honeypot', buyTaxBps: null, sellTaxBps: null, reason, pair: null });
        bump('honeypot');
        flagged.push({ token, pair: `${boughtButCouldNotSell} pairs`, out: { status: 'honeypot', buyTaxBps: null, sellTaxBps: null, stage: null, reason } });
        return;
    }
    if (pairLevelOnly) {
        db.setTokenProbe(token, { status: 'untestable', buyTaxBps: null, sellTaxBps: null, reason: `every root pair rejected the probe (last: ${lastReason})`, pair: null });
        bump('untestable');
    } else {
        bump('error (retry next run)'); // transient RPC trouble — don't record a verdict
    }
}

let next = 0;
async function worker(): Promise<void> {
    while (next < tokens.length) {
        const token = tokens[next++];
        try { await probeToken(token); } catch (err) { bump('error (retry next run)'); rpcErrors++; }
        done++;
        if (done % 25 === 0 || done === tokens.length) {
            process.stdout.write(`\r  ${done}/${tokens.length} probed   ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}   `);
        }
    }
}
await Promise.all(Array.from({ length: Math.min(concurrency, tokens.length) }, worker));
process.stdout.write('\n');

// -----------------------------------------------------------------------------
// Report

console.log('\n' + '─'.repeat(80));
console.log('This run:');
for (const k of [...TOKEN_VERDICTS, 'untestable', 'error (retry next run)']) if (counts[k]) console.log(`  ${k.padEnd(24)} ${counts[k]}`);
if (rpcErrors > 0) console.log(`  (${rpcErrors} probe call(s) hit RPC errors — those tokens will be retried next run)`);
for (const e of errorSamples) console.log(`    ${e}`);

const byStatus = (s: string) => flagged.filter(f => f.out.status === s);
for (const [title, s] of [['🍯 HONEYPOTS (can buy, cannot exit):', 'honeypot'], ['💸 FEE-ON-TRANSFER:', 'fee-on-transfer'], ['🔀 NONSTANDARD (rebasing/reflection):', 'nonstandard'], ['🪦 DEAD (no code):', 'dead']] as const) {
    const rows = byStatus(s);
    if (rows.length === 0) continue;
    console.log(`\n${title} ${rows.length}`);
    for (const f of rows.slice(0, 25)) {
        const tax = f.out.buyTaxBps != null ? `  buy ${(f.out.buyTaxBps / 100).toFixed(2)}% / sell ${((f.out.sellTaxBps ?? 0) / 100).toFixed(2)}%` : '';
        console.log(`   ${f.token}${tax}  — ${f.out.reason.slice(0, 90)}`);
    }
    if (rows.length > 25) console.log(`   ... and ${rows.length - 25} more`);
}

// Factory-level: a factory whose probed pairs are ALL restricted is a
// restricted/honeypot DEX (Panaromaswap-style). Require >=2 samples so one
// odd pair can't condemn a whole factory.
const summary = db.getFactoryProbeSummary();
const restrictedFactories = summary.filter(s => s.restricted >= 2 && s.ok === 0);
const mixedFactories = summary.filter(s => s.restricted > 0 && s.ok > 0);
if (restrictedFactories.length > 0) {
    console.log(`\n⛔ RESTRICTED FACTORIES (every probed pair rejected outsiders):`);
    for (const s of restrictedFactories) console.log(`   ${(factoryName.get(s.factory) ?? s.factory).padEnd(32)} ${s.factory}  restricted=${s.restricted}`);
    if (blacklistRestricted) {
        const res = appendToBlacklist(cfg.chain.label, restrictedFactories.map(s => ({
            address: s.factory,
            reason: `restricted DEX — TokenProbe: ${s.restricted} probed pair(s) rejected swap() from outsiders, 0 accepted`,
        })));
        console.log(`   → blacklist: ${res.added} added, ${res.skipped} already present (conf/${cfg.chain.label}-blacklist.json5)`);
    } else {
        console.log(`   Re-run with --blacklist-restricted to add these to conf/${cfg.chain.label}-blacklist.json5`);
    }
}
if (mixedFactories.length > 0) {
    console.log(`\n⚠️  Factories with SOME restricted pairs (individual pairs excluded, factory kept):`);
    for (const s of mixedFactories) console.log(`   ${(factoryName.get(s.factory) ?? s.factory).padEnd(32)} restricted=${s.restricted} ok=${s.ok}`);
}

console.log('\nAll-time token verdicts:', JSON.stringify(db.getTokenProbeStats()));
console.log(`\nFlagged tokens/pairs are now excluded by getPairsForEnumeration(). Run \`yarn triangles ${cfg.chain.label}\` to rebuild the triangle cache without them.`);
db.close();
