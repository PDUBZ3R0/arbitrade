// Verify every chain's deployed contracts against conf/ and the current source.
//
//   node scripts/verify-deploys.mjs                 every chain with an Ignition journal
//   node scripts/verify-deploys.mjs hyperliquid base   just these conf labels
//
// For each conf/<label>.json5 whose chain id has ignition/deployments/chain-<id>/,
// and for each role the bot uses:
//
//   chain.contract   <- YoBatches3 (else YoBatches2 / YoBatches)
//   chain.executor   <- FlashArbExecutor
//   chain.probe      <- TokenProbe
//   chain.liquidator <- LiquidationExecutor
//
// it prints:
//   conf vs ignition   does conf point at what Ignition says it deployed?
//   code               eth_getCode at the CONF address: none / size in bytes
//   looks like         which of our contracts that bytecode actually is, by
//                      selector fingerprint — catches the "same address, other
//                      chain, swapped role" trap (deployer nonces repeat across
//                      chains, so a copy-pasted conf block lands on a REAL
//                      contract of the wrong type instead of failing loudly)
//   missing            selectors in the CURRENT compiled source absent from the
//                      deployed code — i.e. the deploy predates a source change
//                      and needs a redeploy
//   headroom           24,576 (EIP-170) minus the CURRENT source's runtime size
//
// Selector presence is checked as PUSH4 <selector> in the runtime code, the
// same test liq-watch uses to decide which venues an executor supports.
//
// Read-only: eth_getCode only. Uses each chain's own RPC from conf.

import fs from 'node:fs';
import path from 'node:path';
import { Interface } from 'ethers';
import { loadChainConfig } from '../source/util/config.ts';
import { makeProvider } from '../source/util/rpc.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EIP170 = 24_576;

const ROLES = [
    { key: 'contract',   name: 'YoBatches',            futures: ['Yo3Module#YoBatches3', 'Yo2Module#YoBatches2', 'YoModule#YoBatches'] },
    { key: 'executor',   name: 'FlashArbExecutor',     futures: ['FlashArbModule#FlashArbExecutor'] },
    { key: 'probe',      name: 'TokenProbe',           futures: ['TokenProbeModule#TokenProbe'] },
    { key: 'liquidator', name: 'LiquidationExecutor',  futures: ['LiquidationModule#LiquidationExecutor'] },
];

// --- artifacts ---------------------------------------------------------------

/** Current compiled source (Hardhat): build/artifacts/contracts/<Name>.sol/<Name>.json here, artifacts/ by default. */
function currentArtifact(contractName) {
    for (const dir of ['build/artifacts', 'artifacts']) {
        const p = path.join(ROOT, dir, 'contracts', `${contractName}.sol`, `${contractName}.json`);
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    return null;
}
function ignitionArtifact(chainId, futureId) {
    const p = path.join(ROOT, 'ignition', 'deployments', `chain-${chainId}`, 'artifacts', `${futureId}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const runtimeBytes = (art) => art?.deployedBytecode ? (art.deployedBytecode.length - 2) / 2 : null;
function selectorsOf(art) {
    if (!art?.abi) return [];
    const iface = new Interface(art.abi);
    const out = [];
    iface.forEachFunction(f => out.push({ sel: f.selector.slice(2).toLowerCase(), sig: f.format('sighash') }));
    return out;
}
// solc pushes a selector with the shortest PUSH that holds it: a selector with
// leading zero bytes (0x00ab12cd) is PUSH3 ab12cd, not PUSH4 00ab12cd.
const hasSel = (codeHex, sel) => {
    let s = sel;
    while (s.startsWith('00') && s.length > 2) s = s.slice(2);
    const op = (0x5f + s.length / 2).toString(16);   // PUSH1 = 0x60 ... PUSH4 = 0x63
    return codeHex.includes(op + s);
};

// Fingerprints for "looks like": selectors unique-ish to each contract type.
const KNOWN = {};
for (const r of ROLES) {
    const names = r.key === 'contract' ? ['YoBatches3', 'YoBatches2', 'YoBatches'] : [r.name];
    for (const n of names) {
        const art = currentArtifact(n);
        if (art) KNOWN[n] = selectorsOf(art);
    }
}
function looksLike(codeHex) {
    let best = null, bestScore = 0;
    for (const [name, sels] of Object.entries(KNOWN)) {
        if (!sels.length) continue;
        const hit = sels.filter(s => hasSel(codeHex, s.sel)).length / sels.length;
        if (hit > bestScore) { bestScore = hit; best = name; }
    }
    return bestScore >= 0.6 ? `${best} (${Math.round(bestScore * 100)}%)` : bestScore > 0 ? `unknown (best ${best} ${Math.round(bestScore * 100)}%)` : 'unknown';
}

// --- chains -------------------------------------------------------------------

const deployDirs = fs.readdirSync(path.join(ROOT, 'ignition', 'deployments'))
    .map(d => /^chain-(\d+)$/.exec(d)).filter(Boolean).map(m => Number(m[1]));

const want = process.argv.slice(2);
const labels = (want.length ? want : fs.readdirSync(path.join(ROOT, 'conf'))
    .filter(f => f.endsWith('.json5') && !f.startsWith('@') && !f.endsWith('-blacklist.json5'))
    .map(f => f.replace(/\.json5$/, '')));

const pad = (s, n) => String(s ?? '').padEnd(n);
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
let problems = 0;

for (const label of labels) {
    let cfg;
    try { cfg = loadChainConfig(label); } catch (e) { if (want.length) console.log(`${label}: conf failed to load: ${e.message}`); continue; }
    const chainId = Number(cfg.chain.id);
    if (!deployDirs.includes(chainId)) { if (want.length) console.log(`${label}: no ignition/deployments/chain-${chainId}`); continue; }

    const deployed = JSON.parse(fs.readFileSync(path.join(ROOT, 'ignition', 'deployments', `chain-${chainId}`, 'deployed_addresses.json'), 'utf8'));
    const rawChain = cfg.raw?.chain ?? cfg.chain;
    const provider = makeProvider(cfg.chain, { http: true });

    console.log(`\n${label} (chain ${chainId})`);
    console.log(`  ${pad('role', 11)} ${pad('conf', 13)} ${pad('ignition', 13)} ${pad('match', 6)} ${pad('code', 9)} ${pad('looks like', 30)} missing vs current source`);

    for (const r of ROLES) {
        const confAddr = rawChain?.[r.key];
        const fut = r.futures.find(f => deployed[f]);
        const ignAddr = fut ? deployed[fut] : undefined;
        if (!confAddr && !ignAddr) continue;

        const match = confAddr && ignAddr ? (confAddr.toLowerCase() === ignAddr.toLowerCase() ? 'yes' : 'NO') : '—';
        let code = '0x';
        try { code = confAddr ? (await provider.getCode(confAddr)).toLowerCase() : '0x'; }
        catch (e) { code = null; }
        const size = code == null ? 'rpc err' : code === '0x' ? 'NONE' : `${(code.length - 2) / 2}B`;
        const like = code && code !== '0x' ? looksLike(code) : '—';

        const contractName = fut ? fut.split('#')[1] : r.name;
        const cur = currentArtifact(contractName);
        let missing = '—';
        if (cur && code && code !== '0x') {
            const m = selectorsOf(cur).filter(s => !hasSel(code, s.sel)).map(s => s.sig.split('(')[0]);
            missing = m.length ? m.join(', ') : 'none';
        }

        const bad = match === 'NO' || size === 'NONE' || (like !== '—' && !like.startsWith(contractName.replace(/[23]$/, '')) && !like.startsWith(contractName))
            || (missing !== '—' && missing !== 'none');
        if (bad) problems++;
        console.log(`${bad ? '! ' : '  '}${pad(r.key, 11)} ${pad(short(confAddr), 13)} ${pad(short(ignAddr), 13)} ${pad(match, 6)} ${pad(size, 9)} ${pad(like, 30)} ${missing}`);
        if (match === 'NO') console.log(`               conf ${confAddr}  ignition ${ignAddr}`);
    }
    provider.destroy?.();
}

// Size headroom for the current source, once.
console.log('\ncurrent source runtime size (EIP-170 limit 24,576 B):');
for (const n of ['LiquidationExecutor', 'FlashArbExecutor', 'YoBatches3', 'TokenProbe']) {
    const b = runtimeBytes(currentArtifact(n));
    if (b != null) console.log(`  ${pad(n, 22)} ${String(b).padStart(6)} B   headroom ${String(EIP170 - b).padStart(6)} B${b > EIP170 ? '   OVER LIMIT' : ''}`);
    else console.log(`  ${pad(n, 22)} no artifact (npx hardhat compile)`);
}
console.log(problems ? `\n${problems} row(s) flagged with !` : '\nall rows clean');
process.exit(0);
