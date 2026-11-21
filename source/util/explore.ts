import { get } from 'toltha'
import { loadChainConfig } from './util/config.ts';
const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn run explore <chain-name>');
    console.error('Example: yarn run explore polygon');
    process.exit(1);
}

const config = loadChainConfig(chainArg);

function explore(address){
	get(`${config.explorer}/address/${address}`).then(response=>{
		const $ = response.dom();
		let label = $("#ContentPlaceHolder1_divSummary > div.flex-wrap > div.flex-wrap > a > div > span")?.text();
		let creator = $("#ContentPlaceHolder1_trContract > div > a.hash-tag.text-truncate")?.text();
	})
}