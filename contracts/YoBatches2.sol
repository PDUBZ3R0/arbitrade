//SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Batch reader for the reserves stage. Replaces YoBatches.
///
///   getReserves  — V2-style pools: token balances held by each pair.
///   getV3State   — concentrated-liquidity pools: price, liquidity, fee and the
///                  initialized ticks around the current price.
///
/// getReserves differs from the original YoBatches in two ways, both aimed at
/// fitting more pairs into one eth_call:
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

    // -------------------------------------------------------------------------
    // Concentrated-liquidity state (Uniswap V3 and slot0-compatible forks)
    // -------------------------------------------------------------------------

    /// Everything off-chain V3 math needs, for many pools, in one eth_call:
    /// price, tick, in-range liquidity, fee, tick spacing, and every
    /// initialized tick in a window of bitmap words around the current one.
    ///
    /// Returned as ONE flat uint256[] (signed values in two's complement;
    /// decode int24/int128 fields with BigInt.asIntN(256, x)):
    ///
    ///   out[0]                block.number the state was read at
    ///   then per pool, in input order:
    ///     sqrtPriceX96        0 => slot0() failed; the record is all zeros, n = 0
    ///     tick                int24
    ///     liquidity           uint128
    ///     fee                 pool.fee(), pips; 0 if the pool has no fee()
    ///     tickSpacing         int24; 0 => unreadable, n = 0
    ///     n                   initialized ticks that follow
    ///     n x (tick, liquidityNet)   ascending by tick; liquidityNet is int128
    ///
    /// The window is words [w0 - words, w0 + words], w0 = the bitmap word of
    /// the current tick. Its tick bounds are recomputed off-chain from tick
    /// and tickSpacing, so they are not echoed back. A swap that needs a tick
    /// outside the window must be treated as unpriced — calculus-v3.js's
    /// v3_swap_exact reports exactly that as complete === false.
    ///
    /// Read the same way as getReserves: every external call is a raw
    /// staticcall whose failure or short return degrades to 0 instead of
    /// reverting the batch, so one non-conforming pool cannot cost the rest.
    ///
    /// Layout assumptions, all checked against v3-core 1.0.0 bytecode by
    /// test/test-yobatches-v3.mjs and true of PancakeV3 and the Ramses/Shadow
    /// CL family as far as slot0's first two words and ticks()'s first two
    /// words go. Algebra (globalState, tickTable) is NOT handled: its slot0()
    /// call fails and the record comes back zeroed, which is the safe answer.
    function getV3State(address[] calldata pools, uint256 words) external view returns (uint256[] memory) {
        assembly {
            let out := mload(0x40)
            let w := add(out, 0x40)            // write cursor: past ABI offset + length
            mstore(w, number())
            w := add(w, 0x20)

            for { let i := 0 } lt(i, pools.length) { i := add(i, 1) } {
                let pool := calldataload(add(pools.offset, shl(5, i)))
                let rec := w
                // zero header; fields are filled in as they are read
                mstore(rec, 0) mstore(add(rec, 0x20), 0) mstore(add(rec, 0x40), 0)
                mstore(add(rec, 0x60), 0) mstore(add(rec, 0x80), 0) mstore(add(rec, 0xa0), 0)
                w := add(rec, 0xc0)

                // All calls use scratch space 0x00-0x3f for both input and
                // output; nothing there needs to survive between calls.

                // slot0() -> (uint160 sqrtPriceX96, int24 tick, ...)
                mstore(0x00, shl(224, 0x3850c7bd))
                let ok := staticcall(gas(), pool, 0x00, 4, 0x00, 0x40)
                if lt(returndatasize(), 0x40) { ok := 0 }
                if iszero(ok) { continue }
                let sqrtP := mload(0x00)
                let tick := signextend(2, mload(0x20))
                if iszero(sqrtP) { continue }

                // liquidity() -> uint128
                mstore(0x00, shl(224, 0x1a686502))
                let liq := 0
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { liq := mload(0x00) }
                }

                // fee() -> uint24
                mstore(0x00, shl(224, 0xddca3f43))
                let fee := 0
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { fee := mload(0x00) }
                }

                // tickSpacing() -> int24
                mstore(0x00, shl(224, 0xd0c93a7c))
                let spacing := 0
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { spacing := signextend(2, mload(0x00)) }
                }

                mstore(rec, sqrtP)
                mstore(add(rec, 0x20), tick)
                mstore(add(rec, 0x40), liq)
                mstore(add(rec, 0x60), fee)
                mstore(add(rec, 0x80), spacing)
                if iszero(sgt(spacing, 0)) { continue }

                // compressed = floor(tick / spacing)  (TickBitmap's convention)
                let c := sdiv(tick, spacing)
                if and(slt(tick, 0), iszero(iszero(smod(tick, spacing)))) { c := sub(c, 1) }
                let w0 := sar(8, c)

                let count := 0
                for { let wp := sub(w0, words) } iszero(sgt(wp, add(w0, words))) { wp := add(wp, 1) } {
                    // int16 range only; beyond it there are no words
                    if slt(wp, sub(0, 32768)) { continue }
                    if sgt(wp, 32767) { break }

                    // tickBitmap(int16) -> uint256
                    mstore(0x00, shl(224, 0x5339c296))
                    mstore(0x04, wp)
                    let bm := 0
                    if staticcall(gas(), pool, 0x00, 0x24, 0x00, 0x20) {
                        if iszero(lt(returndatasize(), 0x20)) { bm := mload(0x00) }
                    }

                    for { let b := 0 } and(lt(b, 256), iszero(iszero(shr(b, bm)))) { } {
                        // skip a whole empty byte at a time
                        if iszero(and(shr(b, bm), 0xff)) { b := add(b, 8) continue }
                        if and(shr(b, bm), 1) {
                            let t := mul(add(shl(8, wp), b), spacing)
                            // ticks(int24) -> (uint128 liquidityGross, int128 liquidityNet, ...)
                            mstore(0x00, shl(224, 0xf30dba93))
                            mstore(0x04, t)
                            let net := 0
                            if staticcall(gas(), pool, 0x00, 0x24, 0x00, 0x40) {
                                if iszero(lt(returndatasize(), 0x40)) { net := signextend(15, mload(0x20)) }
                            }
                            mstore(w, t)
                            mstore(add(w, 0x20), net)
                            w := add(w, 0x40)
                            count := add(count, 1)
                        }
                        b := add(b, 1)
                    }
                }
                mstore(add(rec, 0xa0), count)
            }

            mstore(out, 0x20)
            mstore(add(out, 0x20), shr(5, sub(w, add(out, 0x40))))
            return(out, sub(w, out))
        }
    }
}
