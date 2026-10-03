//SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Candidate replacement for YoBatches, for benchmarking against the original.
///
/// Two changes, both aimed at fitting more pairs into one eth_call:
///
/// 1. NO SELF-CALL. The original does `try this.cbalance(...)` around `try
///    token.balanceOf(...)`. The outer wrap is not redundant — Solidity's
///    try/catch catches a revert but NOT a failure to decode the return data,
///    and a malformed decode reverts in the CALLER's frame. Isolating that in
///    a separate call frame is a real defence. But a raw staticcall achieves
///    the same thing far cheaper: it cannot revert the caller at all, and a
///    short or garbage return is detected by checking returndatasize() instead
///    of by a decode that would blow up the frame.
///
/// 2. FLAT RETURNDATA. The original echoes pair/token0/token1 back — 96 of
///    160 bytes per pair that the caller passed in and already knows. Two
///    words per pair in input order carries the same information in 64 bytes.
contract YoBatches2 {
    /// reserves[i*2] = balance of args[i][1] held by args[i][0]
    /// reserves[i*2+1] = balance of args[i][2] held by args[i][0]
    function getReserves(address[3][] calldata args) external view returns (uint256[] memory out) {
        uint256 n = args.length;
        out = new uint256[](n * 2);
        for (uint256 i = 0; i < n; ++i) {
            address pool = args[i][0];
            uint256 a = _bal(args[i][1], pool);
            uint256 b = _bal(args[i][2], pool);
            unchecked {
                out[i * 2] = a;
                out[i * 2 + 1] = b;
            }
        }
    }

    /// balanceOf(pool) or 0, for any reason — no code, revert, or a return too
    /// short to be a uint256. Never reverts.
    ///
    /// extcodesize is deliberately NOT checked first: a staticcall to a
    /// codeless address succeeds with empty returndata, which the length check
    /// already treats as 0. The explicit check would only add an opcode.
    function _bal(address token, address pool) private view returns (uint256 v) {
        assembly {
            let p := mload(0x40)
            // balanceOf(address) selector, left-aligned
            mstore(p, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(add(p, 4), pool)
            // Write the return over the same scratch space; nothing is kept.
            if staticcall(gas(), token, p, 36, p, 32) {
                if iszero(lt(returndatasize(), 32)) { v := mload(p) }
            }
        }
    }
}
