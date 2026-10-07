// Fetch and compile the REAL lending protocols the liquidation tests run against.
//
//   node test/vendor.mjs        (one-time; needs git + network; ~1-3 min)
//
// Morpho Blue (GPL-2.0-or-later) and Compound III / Comet (BUSL-1.1) are
// cloned at pinned commits into test/vendor/ — which is git-ignored, so no
// third-party source or bytecode lands in this (public) repo — and compiled
// with the exact compiler versions their own builds use:
//
//   morpho-blue  solc 0.8.19, viaIR, runs 999999   (as foundry.toml)
//   comet        solc 0.8.15, viaIR, runs 1        (as hardhat.config.ts)
//
// Output: test/vendor/artifacts.json  { <ContractName>: { abi, bytecode } }
//
// The compilers come from npm aliases:  npm i -D solc0819@npm:solc@0.8.19 solc0815@npm:solc@0.8.15

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url).pathname;
const VENDOR = here('./vendor/');

const REPOS = {
    'morpho-blue': { url: 'https://github.com/morpho-org/morpho-blue.git', commit: '8e26ca6a8dbc5089edcd67fb576248810fd2870a' },
    'comet':       { url: 'https://github.com/compound-finance/comet.git', commit: 'f766f51583c23acc33b2a7824654ef2029a96804' },
};

fs.mkdirSync(VENDOR, { recursive: true });
for (const [name, { url, commit }] of Object.entries(REPOS)) {
    const dir = path.join(VENDOR, name);
    if (!fs.existsSync(path.join(dir, '.git'))) {
        console.log(`cloning ${name}…`);
        execFileSync('git', ['init', '-q', dir]);
        execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
    }
    const have = (() => { try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } })();
    if (have !== commit) {
        execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', commit], { stdio: 'inherit' });
        execFileSync('git', ['-C', dir, 'checkout', '-q', commit]);
    }
}

/** Compile `entries` (paths relative to `root`) and everything they import. */
function compile(solcPkg, root, entries, settings) {
    const solc = require(solcPkg);
    const sources = {};
    for (const e of entries) sources[e] = { content: fs.readFileSync(path.join(root, e), 'utf8') };
    const findImports = (p) => {
        for (const base of [root, path.join(root, 'node_modules')]) {
            const f = path.join(base, p);
            if (fs.existsSync(f)) return { contents: fs.readFileSync(f, 'utf8') };
        }
        return { error: `not found: ${p}` };
    };
    const t0 = Date.now();
    const out = JSON.parse(solc.compile(JSON.stringify({
        language: 'Solidity', sources,
        settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    }), { import: findImports }));
    const errs = (out.errors ?? []).filter(e => e.severity === 'error');
    if (errs.length) { for (const e of errs) console.error(e.formattedMessage); process.exit(1); }
    const art = {};
    for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs))
        if (c.evm.bytecode.object) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
    console.log(`  ${solc.version().split('+')[0]}: ${Object.keys(art).length} contracts in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return art;
}

console.log('compiling morpho-blue…');
const morpho = compile('solc0819', path.join(VENDOR, 'morpho-blue'),
    ['src/Morpho.sol', 'src/mocks/IrmMock.sol', 'src/mocks/OracleMock.sol'],
    { optimizer: { enabled: true, runs: 999999 }, viaIR: true, evmVersion: 'paris' });

console.log('compiling comet…');
const comet = compile('solc0815', path.join(VENDOR, 'comet'),
    ['contracts/CometWithExtendedAssetList.sol', 'contracts/CometExtAssetList.sol', 'contracts/AssetListFactory.sol', 'contracts/test/SimplePriceFeed.sol'],
    { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'london' });

const keep = ['Morpho', 'IrmMock', 'OracleMock', 'CometWithExtendedAssetList', 'CometExtAssetList', 'AssetListFactory', 'SimplePriceFeed'];
const art = {};
for (const k of keep) {
    const a = morpho[k] ?? comet[k];
    if (!a) { console.error(`missing ${k}`); process.exit(1); }
    art[k] = a;
}
fs.writeFileSync(path.join(VENDOR, 'artifacts.json'), JSON.stringify(art));
console.log(`wrote test/vendor/artifacts.json (${keep.join(', ')})`);
