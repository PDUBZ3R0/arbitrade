// Duplicate keys in a conf must stop the loader, not silently drop a factory.
//
// Polygon, 2026-10-31: `JetswapV2` appeared twice in factories.v2. JSON5 kept
// the second (0xd54187ea, blacklisted as dead), so the real Jetswap factory
// (0x668ad0ed, 457 pairs) was never loaded, and `yarn cleanup --yes` would
// have deleted its pairs as orphans.
//
//   node --experimental-strip-types test/test-json5-dupes.mjs   (no anvil)

import fs from 'node:fs';
import { findDuplicateKeys } from '../source/util/json5-dupes.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const conf = `{
    // JetswapV2: { a comment is not a key }
    factories: {
        v2: {
            JetswapV2: {
                address: '0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7',
                fee: 0.001,  // "fee": a string in a comment
            },
            'Quoted': { address: "0x01", note: 'a: b, c: {d}' },
            /* JetswapV2: { block comment } */
            JetswapV2: {
                address: '0xd54187ea5a6758fc8abdfaa353aae8f16ca59ef3',
                fee: 0.003,
            },
        },
        v3: { JetswapV2: { address: '0x02' } },
    },
    list: [ { fee: 1, fee: 2 }, { fee: 3 } ],
}`;
const d = findDuplicateKeys(conf);
ok(d.length === 2, 'two duplicates found', JSON.stringify(d));
ok(d.some(x => x.path === 'factories.v2' && x.key === 'JetswapV2' && x.lines[0] === 5 && x.lines[1] === 11),
   'the repeated factory key, with both lines', JSON.stringify(d[0]));
ok(d.some(x => x.path === 'list.0' && x.key === 'fee'), 'a duplicate inside an array element');
ok(!d.some(x => x.path === 'factories.v3'), 'the same name in another group is not a duplicate');
ok(!d.some(x => x.key === 'Quoted' || x.key === 'note' || x.key === 'a'), 'keys and colons inside strings and comments are ignored');

// The loader refuses such a conf (the check loadChainConfig runs on the file's text).
const { loadChainConfig, assertNoDuplicateKeys } = await import('../source/util/config.ts');
const real = fs.readFileSync(new URL('../conf/polygon.json5', import.meta.url), 'utf8');
ok(findDuplicateKeys(real).length === 0, 'conf/polygon.json5 has no duplicates now');
let threw = '';
try { assertNoDuplicateKeys(real.replace(/JetswapV2_d54187ea:/, 'JetswapV2:'), 'conf/polygon.json5'); } catch (e) { threw = e.message; }
ok(/duplicate key.*\n\s+factories\.v2\.JetswapV2 \(lines \d+ and \d+\)/.test(threw), 'the loader check throws, naming the key and both lines', threw.split('\n')[1] ?? '');
ok(loadChainConfig('polygon').factories.some(f => f.address.toLowerCase() === '0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7'), 'Jetswap 0x668ad0ed loads');

console.log(fails ? `\n${fails} FAILED` : '\nALL JSON5-DUPES CHECKS PASS');
process.exit(fails ? 1 : 0);
