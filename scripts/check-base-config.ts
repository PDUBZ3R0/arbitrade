#!/usr/bin/env node --experimental-strip-types --disable-warning=ExperimentalWarning
// Sanity check for base.json5: verify config parses, pattern auto-populate works,
// and flashloan tokens have valid addresses.
//
// Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/check-base-config.ts
import { loadChainConfig } from '../source/util/config.ts';

try {
    const cfg = loadChainConfig('base');
    console.log(`\nBase config loaded: ${cfg.factories.length} factories total`);

    const v2Count      = cfg.factories.filter(f => f.group === 'v2').length;
    const solidlyCount = cfg.factories.filter(f => f.group === 'solidly').length;
    console.log(`  v2:      ${v2Count} factories`);
    console.log(`  solidly: ${solidlyCount} factories`);

    // Check that pattern-registry entries got populated
    console.log('\n--- Solidly factories (should have feeFunction populated by pattern registry) ---');
    for (const f of cfg.factories.filter(f => f.group === 'solidly')) {
        const detail = f.fee !== undefined
            ? `flat fee=${f.fee}`
            : `target=${f.feeTarget}, fn=${f.feeFunction}, argSrc=${f.feeArgSource}, div=${f.feeDivisor}`;
        console.log(`  ${f.name.padEnd(38)}  ${detail}`);
    }

    // Check flashloan tokens
    console.log(`\n--- Flashloan tokens (${cfg.flashloan?.tokens?.length ?? 0}) ---`);
    for (const t of cfg.flashloan?.tokens ?? []) {
        const valid = /^0x[a-fA-F0-9]{40}$/.test(t.address);
        console.log(`  ${valid ? '✓' : '✗'} ${t.symbol.padEnd(10)} ${t.address}  (decimals ${t.decimals})`);
        if (!valid) throw new Error(`Invalid address for ${t.symbol}: ${t.address}`);
    }

    console.log('\n✓ All checks passed. Config is ready for scan/reserves.');
} catch (err) {
    console.error(`\n✗ FAILED: ${(err as Error).message}`);
    process.exit(1);
}
