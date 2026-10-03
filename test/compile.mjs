import solc from 'solc';
import { readFileSync, writeFileSync } from 'fs';
const sources = {
  'FlashArbExecutor.sol': { content: readFileSync(new URL('../contracts/FlashArbExecutor.sol', import.meta.url),'utf8') },
  'Mocks.sol': { content: readFileSync(new URL('./Mocks.sol', import.meta.url),'utf8') },
  'Multicall3Min.sol': { content: readFileSync(new URL('./Multicall3Min.sol', import.meta.url),'utf8') },
};
const input = { language:'Solidity', sources, settings:{ optimizer:{enabled:true,runs:200}, evmVersion:'shanghai',
  outputSelection:{'*':{'*':['abi','evm.bytecode.object']}} } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors||[]).filter(e=>e.severity==='error');
for (const e of out.errors||[]) console.log(`[${e.severity}] ${e.formattedMessage.split('\n')[0]}`);
if (errs.length) process.exit(1);
const art = {};
for (const [f,cs] of Object.entries(out.contracts)) for (const [n,c] of Object.entries(cs))
  art[n] = { abi:c.abi, bytecode:'0x'+c.evm.bytecode.object };
writeFileSync(new URL('./artifacts.json', import.meta.url), JSON.stringify(art));
console.log('compiled:', Object.keys(art).join(', '));
