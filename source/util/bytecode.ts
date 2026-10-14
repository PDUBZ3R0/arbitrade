// Does deployed runtime code contain a function? (selector fingerprinting)
//
// solc's dispatcher compares the calldata selector against each function's
// selector pushed as an immediate. It uses the SHORTEST push that holds the
// value, so a selector with leading zero bytes is not PUSH4:
//
//   0x12ab34cd  ->  63 12ab34cd   (PUSH4)
//   0x00ab34cd  ->  62 ab34cd     (PUSH3)
//   0x0000_34cd ->  61 34cd       (PUSH2)
//
// Matching only "63" + selector (or the bare 8 hex chars) reports such a
// function as missing from code that has it. This is a fingerprint, not a
// disassembly: a false positive needs the exact PUSHn+bytes sequence to occur
// by chance elsewhere in the code, which is negligible for n >= 3.

import { id } from 'ethers';

/** 4-byte selector of a signature like "HOP_STABLE()", as 8 lowercase hex chars. */
export const selectorOf = (signature: string): string => id(signature).slice(2, 10);

/** True if `code` (0x-prefixed runtime bytecode, any case) pushes `selector` (8 hex chars, optional 0x). */
export function hasSelector(code: string, selector: string): boolean {
    let s = selector.replace(/^0x/, '').toLowerCase();
    while (s.length > 2 && s.startsWith('00')) s = s.slice(2);
    const push = (0x5f + s.length / 2).toString(16);   // PUSH1 = 0x60 … PUSH4 = 0x63
    return code.toLowerCase().includes(push + s);
}
