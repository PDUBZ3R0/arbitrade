// -----------------------------------------------------------------------------
// What a V2-shaped pair's code can do to a trade, read from heimdall's
// decompilation (run with --skip-resolving, so every call shows its raw
// selector and every getter its selector-named `unresolved_xxxxxxxx`).
//
// Polygon, 2026-10-31: WPOL/DAI 0xd4ba843f (factory 0x7e48de0a) has the same
// thirteen functions as a stock QuickSwap pair, and its factory looked like
// any UniswapV2 copy. The difference is two lines inside swap(): it calls
// fee() (0xddca3f43) on a hard-coded contract, 0xe00b4a22, whose answer was
// 300 per mille. verify-fees had it at 0.3%, and the hot loop's simulations
// reverted "UniswapV2: K" 35 times through it. A stock swap() calls only
// token0/token1 (transfer, balanceOf) and the `to` callback; anything else it
// calls can change the price or refuse the trade, so it is reported here.
//
// Verdicts:
//   trap         swap() asks a contract other than the factory or the tokens
//                (the fee, or permission), gates on tx.origin or a per-address
//                flag, or the pair can delegatecall / selfdestruct.
//   watch        the fee or a pause is read from the factory (normal for
//                Solidly, but owner-set), the pair has owner-gated setters, or
//                it is an upgradeable proxy.
//   ok           a stock swap().
//   unclassified no V2 swap(uint256,uint256,address,bytes) (V3, Algebra) or
//                no decompilation.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SWAP = '022c0d9f';
// Getters heimdall names by selector: token0(), token1(), factory().
const TOKEN_GETTERS = new Set(['unresolved_0dfe1681', 'unresolved_d21220a7']);
const FACTORY_GETTER = 'unresolved_c45a0155';
// What a pair legitimately asks its tokens: _safeTransfer's low-level call
// (heimdall shows its selector as 00000000), transfer, transferFrom, balanceOf.
const TOKEN_SELECTORS = new Set(['00000000', 'a9059cbb', '23b872dd', '70a08231']);
// The pair surface every V2/Solidly fork has; any other state-changing function is the pair's own.
const PAIR_SURFACE = new Set([
    '095ea7b3', 'a9059cbb', '23b872dd', 'd505accf',             // approve, transfer, transferFrom, permit
    '485cc955', 'e4bbb5a8',                                     // initialize(address,address), initialize(address,address,bool)
    '6a627842', '89afcb44', SWAP, 'bc25cf77', 'fff6cae9',       // mint, burn, swap, skim, sync
    'd294f093', '39509351', 'a457c2d7',                         // claimFees, increaseAllowance, decreaseAllowance
]);

// Selectors seen in Polygon pair code on 2026-10-31 (openchain), for the report.
const NAMES: Record<string, string> = {
    ddca3f43: 'fee()', a6ae80e2: 'swapFee(address)', '0cf6ee84': 'getPairFee(address)', '3556d194': 'getFeeForPair(address)',
    '9af608c9': 'getFees(address)', '1df4ccfc': 'totalFee()', d0fb0203: 'feeManager()', '6999b377': 'feeController()',
    '62bdc32f': 'getFeeDistribution(address)', '01a362a8': 'discountMgr()', befa96ce: 'discountOf(address)',
    '0e2789bb': 'exchangeConfig()', '4cf088d9': 'staking()', f887ea40: 'router()',
    b187bd26: 'isPaused()', '5c975abb': 'paused()', '2e48152c': 'paused(address)', d84f4460: 'poolPaused(address)',
    '3af32abf': 'isWhitelisted(address)', '54789a5e': 'isWhitelistedAccount(address)', acad5b69: 'isAllowedToSwap(address)',
    '6a29ea74': 'isAllowedToSwap()', f3d7d282: 'isRouter(address)', '6177fd18': 'isStaked(address)', '68b959cc': 'isDisableFlashLoan(address)',
};
// Asking whether this caller may trade: a pair that does this can refuse us after a simulation passed.
const PERMISSION = new Set(['3af32abf', '54789a5e', 'acad5b69', '6a29ea74', 'f3d7d282', '6177fd18', '68b959cc']);
// heimdall renders a revert's Error(string) encoding as a call; it isn't one.
const NOT_A_CALL = new Set(['08c379a0']);
const label = (sel: string) => NAMES[sel] ?? `0x${sel}`;

export type Verdict = 'trap' | 'watch' | 'ok' | 'unclassified';
export type PairCodeReport = { verdict: Verdict; findings: Array<{ level: 'trap' | 'watch'; what: string }> };

type Fn = { selector: string; signature: string; body: string; view: boolean };

/** heimdall's source split into its functions (each starts at a `@custom:selector` comment). */
export function functionsOf(sol: string): Fn[] {
    return sol.split(/\n\s*\/\/\/ @custom:selector\s+0x/).slice(1).map(p => {
        const signature = /@custom:signature\s+(.*)/.exec(p)?.[1].trim() ?? '';
        return { selector: p.slice(0, 8).toLowerCase(), signature, body: p, view: /\b(view|pure)\b/.test(signature) };
    });
}

const CALL = /address\(([^()]*(?:\([^()]*\))?[^()]*)\)\s*\.\s*(?:\{[^}]*\}\s*)?Unresolved_([0-9a-f]{8})\s*\([^;]*;\s*\/\/\s*(call|staticcall|delegatecall)/g;

/** Every external call in a function body: its target expression, selector and kind. */
export function callsIn(body: string): Array<{ target: string; selector: string; kind: string }> {
    return [...body.matchAll(CALL)].map(m => ({ target: m[1].trim(), selector: m[2], kind: m[3] }));
}

/**
 * opts.factory / opts.tokens: the pair's own factory and tokens. Solidly-style
 * pairs compile them in as immutables, so their calls show hard-coded
 * addresses; without these, isPaused() on the pair's own factory reads as a
 * call to an unknown contract.
 */
export function classifyPairCode(sol: string, opts: { proxy?: string | null; factory?: string; tokens?: string[] } = {}): PairCodeReport {
    const fns = functionsOf(sol);
    const swap = fns.find(f => f.selector === SWAP);
    if (!swap) return { verdict: 'unclassified', findings: [] };

    const findings: PairCodeReport['findings'] = [];
    const seen = new Set<string>();
    const add = (level: 'trap' | 'watch', what: string) => { if (!seen.has(what)) { seen.add(what); findings.push({ level, what }); } };

    const factory = opts.factory?.toLowerCase();
    const tokens = new Set((opts.tokens ?? []).map(t => t.toLowerCase()));
    for (const c of callsIn(swap.body)) {
        if (NOT_A_CALL.has(c.selector)) continue;
        if (c.kind === 'delegatecall') { add('trap', `swap() delegatecalls ${c.target}`); continue; }
        // The `to` callback (uniswapV2Call, pancakeCall, hook, …) goes to an argument.
        if (/^arg\d+$/.test(c.target)) continue;
        // heimdall writes a packed getter as `unresolved_c45a0155 / 0x01`; the address is the getter's.
        const target = c.target.replace(/\s*[/&]\s*0x[0-9a-f]+$/i, '');
        const literal = /^0x[0-9a-f]{40}$/i.test(target) ? target.toLowerCase() : null;
        const isToken = TOKEN_GETTERS.has(target) || (literal !== null && tokens.has(literal));
        const isFactory = target === FACTORY_GETTER || (literal !== null && literal === factory);
        if (TOKEN_SELECTORS.has(c.selector) && (isToken || literal === null)) continue;
        const verb = c.kind === 'staticcall' ? 'reads' : 'calls';
        if (PERMISSION.has(c.selector)) { add('trap', `swap() asks ${isFactory ? 'the factory' : target} ${label(c.selector)}: it can refuse callers`); continue; }
        if (isFactory) { add('watch', `swap() ${verb} ${label(c.selector)} from the factory`); continue; }
        if (isToken) { add('trap', `swap() calls ${label(c.selector)} on a token (not transfer/balanceOf)`); continue; }
        const where = literal ? `hard-coded ${literal}` : /^(?:store|unresolved)_\w+$/.test(target) ? `stored address ${target}` : 'an address read at run time';
        add('trap', `swap() ${verb} ${label(c.selector)} on ${where}`);
    }
    if (/tx\.origin/.test(swap.body)) add('trap', 'swap() checks tx.origin');
    if (/require\([^;]*storage_map_\w+\[\s*(?:address\()?\s*(?:msg\.sender|tx\.origin|arg2)\b/.test(swap.body))
        add('trap', 'swap() requires a per-address flag (whitelist or blacklist)');
    if (/delegatecall/.test(sol) && !findings.some(f => /delegatecall/.test(f.what))) add('trap', 'the pair can delegatecall');
    if (/selfdestruct/.test(sol)) add('trap', 'the pair can selfdestruct');

    const setters = fns.filter(f => !f.view && !PAIR_SURFACE.has(f.selector)
        && /require\([^;]*\bmsg\.sender\b[^;]*==|require\([^;]*==[^;]*\bmsg\.sender\b/.test(f.body));
    if (setters.length) add('watch', `owner-gated setter(s): ${setters.map(f => '0x' + f.selector).join(', ')}`);
    if (opts.proxy) add('watch', `upgradeable pair: ${opts.proxy}`);

    return {
        verdict: findings.some(f => f.level === 'trap') ? 'trap' : findings.length ? 'watch' : 'ok',
        findings,
    };
}

/** heimdall's decompilation of runtime code (hex), names left unresolved. */
export async function decompilePairCode(code: string, timeoutMs = 180_000): Promise<{ sol: string } | { error: string }> {
    const bifrost = path.join(os.homedir(), '.bifrost', 'bin', 'heimdall');
    const bin = process.env.HEIMDALL ?? (fs.existsSync(bifrost) ? bifrost : 'heimdall');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-'));
    try {
        await run(bin, ['decompile', code, '--include-sol', '--skip-resolving', '-o', dir], { timeout: timeoutMs, maxBuffer: 64 << 20 });
        const f = path.join(dir, 'decompiled.sol');
        if (!fs.existsSync(f)) return { error: 'heimdall wrote no decompiled.sol' };
        return { sol: fs.readFileSync(f, 'utf8').replace(/\u0000/g, '') };
    } catch (e) {
        return { error: `heimdall: ${String((e as Error).message ?? e).split('\n')[0].slice(0, 200)}` };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
