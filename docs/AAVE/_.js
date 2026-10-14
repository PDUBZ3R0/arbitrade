
import fs from 'fs'
import path from 'path'

const files = fs.readdirSync(import.meta.dirname);
let out = {};
for (const f of files) {
	if (/\.json$/.test(f)) {
		const data = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, f)));
		out[f.replace(/\sV3\sMarket\.json/, '')] = data.pool;
	}
}
fs.writeFileSync("aave.json", JSON.stringify(out, null, 2));