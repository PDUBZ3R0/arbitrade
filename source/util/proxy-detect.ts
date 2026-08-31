// -----------------------------------------------------------------------------
// Proxy detection.
//
// Modern upgradeable contracts follow EIP-1967, which reserves specific
// storage slots for the implementation address. Reading that slot with
// eth_getStorageAt reveals the underlying implementation without needing
// any special interface — works for OpenZeppelin's TransparentUpgradeable-
// Proxy, UUPS, and most other EIP-1967-compliant patterns.
//
// Why this matters for arbitrade:
//   - Etherscan shows the proxy's contract name (e.g. "TransparentUpgradeable-
//     Proxy") — not useful for identifying which DEX it is
//   - The IMPLEMENTATION has the meaningful contract name (e.g. "PairFactory"
//     for Retro Finance)
//   - Once we know the implementation, we can identify the DEX and infer its
//     fee model (Retro = 0.05% flat, Cone = per-pair, etc.)
//
// Storage slots (EIP-1967):
//   Implementation: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
//                 = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
//   Beacon:         bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1)
//                 = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50
//   Admin:          bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)
//                 = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103
//
// The implementation slot is the useful one. Beacon proxies point at a
// beacon contract that in turn exposes `implementation()`; we handle that
// with a second call.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface } from 'ethers';

export const EIP1967_IMPL_SLOT   = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

const iface = new Interface(['function implementation() view returns (address)']);
const SEL_implementation = iface.getFunction('implementation')!.selector;

export type ProxyInfo = {
    isProxy: boolean;
    /** Address of the implementation contract, if a proxy pattern was detected. */
    implementation: string | null;
    /** Which pattern matched (or null if not a proxy). */
    proxyType: 'eip1967' | 'eip1967-beacon' | null;
};

/**
 * Decode a 32-byte storage word as an Ethereum address.
 * Storage stores addresses right-aligned in the low 20 bytes.
 * Returns null for the zero address (which means "slot unused").
 */
function slotToAddress(hex: string): string | null {
    if (!hex || hex.length !== 66 || !hex.startsWith('0x')) return null;
    const addr = '0x' + hex.slice(-40).toLowerCase();
    if (addr === '0x0000000000000000000000000000000000000000') return null;
    return addr;
}

/**
 * Check whether a contract address is an EIP-1967 proxy, and if so return
 * its implementation address. Non-throwing: unknown pattern = returns
 * `{ isProxy: false, implementation: null, proxyType: null }`.
 *
 * Total cost: 1 eth_getStorageAt call for direct proxies, 2 for beacon
 * proxies. Both are extremely cheap even on rate-limited RPCs.
 */
export async function detectProxy(
    provider: JsonRpcProvider,
    address: string,
): Promise<ProxyInfo> {
    // Try EIP-1967 implementation slot first (covers OpenZeppelin
    // TransparentUpgradeableProxy, UUPS, and most modern patterns).
    try {
        const implSlot = await provider.getStorage(address, EIP1967_IMPL_SLOT);
        const impl = slotToAddress(implSlot);
        if (impl) {
            return { isProxy: true, implementation: impl, proxyType: 'eip1967' };
        }
    } catch { /* fall through to beacon check */ }

    // Try beacon slot — beacon proxies store a beacon address that in turn
    // exposes implementation(). Two hops but same standard.
    try {
        const beaconSlot = await provider.getStorage(address, EIP1967_BEACON_SLOT);
        const beacon = slotToAddress(beaconSlot);
        if (beacon) {
            // Call implementation() on the beacon
            try {
                const implData = await provider.call({ to: beacon, data: SEL_implementation });
                if (implData && implData !== '0x') {
                    const decoded = iface.decodeFunctionResult('implementation', implData)[0] as string;
                    if (decoded && decoded !== '0x0000000000000000000000000000000000000000') {
                        return { isProxy: true, implementation: decoded.toLowerCase(), proxyType: 'eip1967-beacon' };
                    }
                }
            } catch { /* beacon call failed; not a usable proxy */ }
        }
    } catch { /* no beacon slot either */ }

    return { isProxy: false, implementation: null, proxyType: null };
}

/**
 * Heuristic to fast-reject non-proxy contracts before wasting a
 * getStorageAt call. Real proxy bytecode is very small (typically
 * under 500 bytes — just a delegatecall stub) — real DEX factory
 * bytecode is 5-30 KB. If a contract has substantial bytecode, it's
 * definitely not a minimal proxy, so we can skip the storage check.
 *
 * Not needed for correctness; detectProxy() works on any address.
 * Just an optimization for classifiers that check hundreds of
 * contracts.
 */
export function couldBeProxy(bytecodeHex: string): boolean {
    if (!bytecodeHex || bytecodeHex === '0x') return false;
    // Strip 0x, each byte = 2 hex chars
    const bytes = (bytecodeHex.length - 2) / 2;
    // Minimal proxies: 45 bytes (EIP-1167). Full TransparentUpgradeableProxy: ~2KB.
    // Anything under ~3KB could plausibly be a proxy.
    return bytes < 3000;
}
