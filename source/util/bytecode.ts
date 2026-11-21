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

import { id, type JsonRpcProvider } from 'ethers';

/** 4-byte selector of a signature like "HOP_STABLE()", as 8 lowercase hex chars. */
export const selectorOf = (signature: string): string => id(signature).slice(2, 10);

/** True if `code` (0x-prefixed runtime bytecode, any case) pushes `selector` (8 hex chars, optional 0x). */
export function hasSelector(code: string, selector: string): boolean {
    let s = selector.replace(/^0x/, '').toLowerCase();
    while (s.length > 2 && s.startsWith('00')) s = s.slice(2);
    const push = (0x5f + s.length / 2).toString(16);   // PUSH1 = 0x60 … PUSH4 = 0x63
    return code.toLowerCase().includes(push + s);
}

/**
 * Does a wrapped-native candidate actually wrap anything? A symbol proves
 * nothing: on Ronin 0x4200…0006 answers "WRON" and holds 0 RON, while the real
 * WRON at 0xe514…bcd4 holds 63M. WETH9-style tokens keep the native coin in
 * their own balance, so an empty one is not the token DEXes pair against.
 */
export async function holdsNative(provider: JsonRpcProvider, address: string): Promise<boolean> {
    try { return (await provider.getBalance(address)) > 0n; } catch { return false; }
}

// ---- proxies ------------------------------------------------------------------
//
// Reading a proxy's own code finds a dispatcher, not the contract. Katana's
// pairs on Ronin are the case that taught this: a V2 pair holding $8M answers
// getReserves() and swap() through a proxy with neither selector in its own
// code, so the fee audit called it NO-SWAP and held the chain's main DEX back.
// Those pairs use none of the standard slots: the proxy asks its own
// implementation() getter. Katana V3 pools are EIP-1967 beacon proxies.

const CLONE = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i;
const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const IMPLEMENTATION = '0x5c60da1b';   // implementation()

const addressWord = (w: string): string | null =>
    /^0x[0-9a-fA-F]{64}$/.test(w) && BigInt(w) !== 0n ? '0x' + w.slice(-40).toLowerCase() : null;

export type ProxyKind = 'clone' | 'eip1967' | 'beacon' | 'getter';
export type ResolvedCode = { code: string; impl: string | null; kind: ProxyKind | null };

/** implementation() on `target`, or null when it has no such getter. */
async function implementationOf(provider: JsonRpcProvider, target: string): Promise<string | null> {
    try { return addressWord(await provider.call({ to: target, data: IMPLEMENTATION })); } catch { return null; }
}

/**
 * The code that actually runs at `address`: its own, or its implementation's
 * when it is a clone, an EIP-1967 proxy, a beacon proxy, or a proxy with an
 * implementation() getter. Falls back to the address's own code when the
 * implementation has none, so a false match can't blank a working contract.
 */
export async function resolveCode(provider: JsonRpcProvider, address: string): Promise<ResolvedCode> {
    const code = await provider.getCode(address);
    const own: ResolvedCode = { code, impl: null, kind: null };
    if (code === '0x') return own;

    const follow = async (impl: string | null, kind: ProxyKind): Promise<ResolvedCode | null> => {
        if (!impl || impl === address.toLowerCase()) return null;
        const target = await provider.getCode(impl);
        return target === '0x' ? null : { code: target, impl, kind };
    };

    const clone = CLONE.exec(code);
    if (clone) return await follow('0x' + clone[1].toLowerCase(), 'clone') ?? own;

    const direct = await follow(addressWord(await provider.getStorage(address, EIP1967_IMPL)), 'eip1967');
    if (direct) return direct;

    const beacon = addressWord(await provider.getStorage(address, EIP1967_BEACON));
    if (beacon) {
        const viaBeacon = await follow(await implementationOf(provider, beacon), 'beacon');
        if (viaBeacon) return viaBeacon;
    }

    // Only ask when the code itself carries the getter: a real implementation
    // with an unrelated fallback must not be mistaken for a proxy.
    if (hasSelector(code, IMPLEMENTATION)) return await follow(await implementationOf(provider, address), 'getter') ?? own;
    return own;
}
