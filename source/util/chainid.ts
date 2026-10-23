#!/usr/bin/env node --experimental-strip-types --disable-warning=ExperimentalWarning

import JSON5 from 'json5'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const c = JSON5.parse(readFileSync(join(import.meta.dirname,'../../conf/@chains.json5'), 'utf8'));
const CHAIN = process.argv[process.argv.length - 1];
if (c[CHAIN]?.id) process.stdout.write(String(c[CHAIN]?.id));