import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { readFileSync } from 'fs';
const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url),'utf8'));
const provider = new JsonRpcProvider('http://127.0.0.1:8545', undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
const deploy = async (n,...a)=>{const f=new ContractFactory(art[n].abi,art[n].bytecode,w);const c=await f.deploy(...a);await c.waitForDeployment();return c;};
const E=(n)=>BigInt(Math.round(n))*10n**18n;
const ppm=(d)=>Math.round(d*1e6);

async function cycle(nHops, edge) {
  const root = await deploy('MockToken','ROOT',0);
  const toks = [root];
  for (let i=1;i<nHops;i++) toks.push(await deploy('MockToken','T'+i,0));
  const addr = await Promise.all(toks.map(t=>t.getAddress()));
  const pairs=[], paddr=[];
  for (let i=0;i<nHops;i++) {
    const a=addr[i], b=addr[(i+1)%nHops];
    const p=await deploy('MockPair',a,b,30); pairs.push(p); paddr.push(await p.getAddress());
  }
  for (let i=0;i<nHops;i++) {
    const a=toks[i], b=toks[(i+1)%nHops];
    await (await a.mint(paddr[i], E(1_000_000))).wait();
    await (await b.mint(paddr[i], E(i===nHops-1 ? 1_000_000*edge : 1_000_000))).wait();
    await (await pairs[i].sync()).wait();
  }
  const pool=await deploy('MockAavePool',5n); const POOL=await pool.getAddress();
  await (await root.mint(POOL,E(10_000_000))).wait();
  const exec=await deploy('FlashArbExecutor',POOL); const EX=await exec.getAddress();
  const hops = [];
  for (let i=0;i<nHops;i++) hops.push({ pair:paddr[i], tokenIn:addr[i], feePpm:3000, recipient: i===nHops-1?EX:paddr[i+1], kind: 0 });
  const tx = await exec.executeArb(addr[0], E(1000), 0n, hops);
  const rc = await tx.wait();
  return rc.gasUsed;
}
console.log('New contract, mock pairs + mock Aave (lower bound — mocks are simpler than real):');
for (const n of [2,3]) {
  const g = await cycle(n, 1.20);
  console.log(`  ${n}-hop: ${g.toString()} gas`);
}
