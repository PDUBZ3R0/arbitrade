
import fs from 'fs'
import path from 'path'
import JSON5 from 'json5'

const files = fs.readdirSync(import.meta.dirname);
const conf = JSON5.parse(fs.readFileSync(path.join(import.meta.dirname, "../../conf", "@chains.json5")), "utf-8");
let out = {};
for (const f of files) {
	if (/\.json$/.test(f)) {
		const data = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, f)));
		let slug = f.replace(/\sV3\sMarket\.json/, '').replace(/\s/g,'').toLowerCase();
		out[slug] = {
			id: conf[slug]?.id,
			pool: data.pool
		}
	}
}
fs.writeFileSync("aave.json", JSON.stringify(out, null, 2));