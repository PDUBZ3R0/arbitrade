// contract-update's textual edits, including the copy of chain.probe / chain.sniper into sniper's conf.
//   node --experimental-strip-types test/test-contract-update.mjs
import JSON5 from 'json5';
import { applyUpdates, mirrorFields } from '../source/util/contract-update.ts';

let failed = 0;
const ok = (c, msg) => { console.log(`  ${c ? '✓' : '✗'} ${msg}`); if (!c) failed++; };
const P = '0x77b9D93ab7F27E5f52507F3dDfb3736e3c3FB90E', S = '0xE032f692DeC7D007aD08aDE78eBf36A82C55e117', OLD = '0x1111111111111111111111111111111111111111';

const arb = `{
  chain: {
    id: 56,
    name: "Binance Smart Chain",
    contract: '0x2222222222222222222222222222222222222222',
    probe: '${P}',
    sniper: '${S}',
  },
  flashloan: { pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB" }
}`;
const sniper = `{
  chain: {
    id: 56,
    label: 'bsc', // a comment that must survive
    portal: 'binance-mainnet',
    probe: '${OLD}',
  },
  live: {
    probe: 'not this one',
  },
}`;
const r = mirrorFields(arb, sniper);
const c = JSON5.parse(r.text).chain;
ok(c.probe === P && c.sniper === S, 'sniper gets arbitrade\'s chain.probe (replaced) and chain.sniper (added)');
ok(!('contract' in c), 'only probe and sniper are copied: sniper has no use for YoBatches');
ok(r.text.includes('// a comment that must survive') && JSON5.parse(r.text).live.probe === 'not this one', 'comments and the rest of the file are left as they were');
ok(r.changes.find(x => x.field === 'probe').action === 'replaced' && r.changes.find(x => x.field === 'sniper').action === 'inserted', 'changes: probe replaced, sniper inserted');
ok(mirrorFields(r.text.replace(/probe: '[^']*'/, `probe: '${P}'`), r.text).changes.every(x => x.action === 'unchanged'), 'a second run changes nothing');
ok(mirrorFields('{ chain: { id: 56 } }', sniper) === null, 'arbitrade has neither field: nothing to copy');
const a = applyUpdates(arb, [{ field: 'probe', future: 'TokenProbeModule#TokenProbe', address: OLD }]);
ok(JSON5.parse(a.text).chain.probe === OLD && a.changes[0].previous === P, 'applyUpdates still replaces a field in arbitrade\'s own conf');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
