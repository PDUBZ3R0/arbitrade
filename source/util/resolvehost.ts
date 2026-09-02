
import {loadChainConfig} from './config.ts'

(function init() {
	let conf = loadChainConfig(process.argv[2]);
	if (conf) {
		console.log(conf.chain.host);
	}
})()