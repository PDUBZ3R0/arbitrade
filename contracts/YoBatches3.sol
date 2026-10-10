//SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./YoBatches2.sol";

/// YoBatches2 plus PACKED variants of both reads.
///
/// Why: the reserves stage is bandwidth-bound wherever the link is slow. Over
/// JSON-RPC every byte travels as two hex characters, and the ABI layouts of
/// YoBatches2 are mostly padding: a pair costs 96 bytes of calldata (three
/// left-padded addresses, two of which are the same handful of root tokens
/// again and again) and 64 bytes back (two uint256 balances that usually fit
/// in 9-12 bytes); a v3 tick costs 64 bytes back for an int24 and an int128.
/// Measured on Base from a 5G uplink, the prefilter moved ~1.5 GB in 28
/// minutes. The packed forms carry the same information in roughly a quarter
/// of the calldata and a third of the returndata.
///
/// The original functions are inherited unchanged, so YoBatches3 is a
/// drop-in chain.contract: the client uses the packed calls when the
/// deployed bytecode has them and the ABI ones otherwise.
///
/// ---------------------------------------------------------------------------
/// getReservesPacked(bytes req) -> bytes
///   req: u16 nTokens | nTokens x address(20) | per pair: pool(20) u16 iA u16 iB
///        (iA/iB index the token table; 24 bytes per pair instead of 96)
///   out: per pair, balanceOf(tokenA, pool) then balanceOf(tokenB, pool), each
///        as a VAR: u8 length L (0..32) followed by L big-endian bytes.
///        Any failure reads as 0 (L = 0), exactly like getReserves.
///
/// getReservesByPool(bytes pools) -> bytes
///   pools: 20-byte addresses back to back (20 bytes per pair, nothing else)
///   out: per pool, balanceOf(pool.token0(), pool) then balanceOf(pool.token1(),
///        pool), as VARs. The contract asks the pool for its tokens, which
///        costs two extra calls per pair on the node and saves the client from
///        sending them: on a typical batch most pairs have one token no other
///        pair in the batch shares, so a token table cannot compress it.
///        A pool whose token0()/token1() fails reads as 0 / 0.
///
/// getV3StatePacked(bytes pools, uint256 words) -> bytes
///   pools: 20-byte addresses back to back
///   out: u64 block | per pool:
///        u8 ok (0: slot0 failed or tickSpacing <= 0 — nothing else follows)
///        VAR sqrtPriceX96 | int24 tick | VAR liquidity | u24 fee | int24 spacing
///        u16 n | n x (int24 tick, int128 liquidityNet)    (19 bytes per tick)
///   Same reads, same window, same tolerance of junk pools as getV3State.
/// ---------------------------------------------------------------------------
contract YoBatches3 is YoBatches2 {

    function getReservesPacked(bytes calldata req) external view returns (bytes memory) {
        assembly {
            // Yul helpers first: solc flags functions defined after return() as unreachable.
            // balanceOf(pool) via scratch space 0x00-0x3f; never reverts.
            function bal(token, pool) -> v {
                mstore(0x00, 0x70a0823100000000000000000000000000000000000000000000000000000000)
                mstore(0x04, pool)
                if staticcall(gas(), token, 0x00, 0x24, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { v := mload(0x00) }
                }
            }
            // u8 length + minimal big-endian bytes. Writes a full word, advances 1+L.
            function putVar(ptr, v) -> np {
                let l := 0
                for { let x := v } x { x := shr(8, x) } { l := add(l, 1) }
                mstore8(ptr, l)
                if l { mstore(add(ptr, 1), shl(mul(8, sub(32, l)), v)) }
                np := add(ptr, add(1, l))
            }

            let out := mload(0x40)
            let w := add(out, 0x20)
            let base := req.offset
            let end := add(base, req.length)
            let nTok := shr(240, calldataload(base))
            let tokTab := add(base, 2)
            let p := add(tokTab, mul(nTok, 20))
            for { } lt(p, end) { p := add(p, 24) } {
                let pool := shr(96, calldataload(p))
                let ia := shr(240, calldataload(add(p, 20)))
                let ib := shr(240, calldataload(add(p, 22)))
                // An index outside the table reads as a zero address, whose
                // balanceOf "succeeds" with empty returndata: 0, as intended.
                let ta := 0
                let tb := 0
                if lt(ia, nTok) { ta := shr(96, calldataload(add(tokTab, mul(ia, 20)))) }
                if lt(ib, nTok) { tb := shr(96, calldataload(add(tokTab, mul(ib, 20)))) }
                w := putVar(w, bal(ta, pool))
                w := putVar(w, bal(tb, pool))
            }
            // ABI-encode `bytes` in place and return: [0x20][len][data][zero pad].
            // The word before `out` belongs to memory nothing will read again.
            let len := sub(w, add(out, 0x20))
            mstore(out, len)
            mstore(w, 0)
            mstore(sub(out, 0x20), 0x20)
            return(sub(out, 0x20), add(0x40, and(add(len, 31), not(31))))
        }
    }

    function getReservesByPool(bytes calldata pools) external view returns (bytes memory) {
        assembly {
            // Yul helpers first: solc flags functions defined after return() as unreachable.
            function tok(pool, sel) -> t {
                mstore(0x00, shl(224, sel))
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { t := and(mload(0x00), 0xffffffffffffffffffffffffffffffffffffffff) }
                }
            }
            function bal(token, pool) -> v {
                if iszero(token) { leave }
                mstore(0x00, 0x70a0823100000000000000000000000000000000000000000000000000000000)
                mstore(0x04, pool)
                if staticcall(gas(), token, 0x00, 0x24, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { v := mload(0x00) }
                }
            }
            function putVar(ptr, v) -> np {
                let l := 0
                for { let x := v } x { x := shr(8, x) } { l := add(l, 1) }
                mstore8(ptr, l)
                if l { mstore(add(ptr, 1), shl(mul(8, sub(32, l)), v)) }
                np := add(ptr, add(1, l))
            }

            let out := mload(0x40)
            let w := add(out, 0x20)
            let n := div(pools.length, 20)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let pool := shr(96, calldataload(add(pools.offset, mul(i, 20))))
                w := putVar(w, bal(tok(pool, 0x0dfe1681), pool))   // token0()
                w := putVar(w, bal(tok(pool, 0xd21220a7), pool))   // token1()
            }
            let len := sub(w, add(out, 0x20))
            mstore(out, len)
            mstore(w, 0)
            mstore(sub(out, 0x20), 0x20)
            return(sub(out, 0x20), add(0x40, and(add(len, 31), not(31))))
        }
    }

    function getV3StatePacked(bytes calldata pools, uint256 words) external view returns (bytes memory) {
        assembly {
            // Yul helpers first: solc flags functions defined after return() as unreachable.
            function putVar(ptr, v) -> np {
                let l := 0
                for { let x := v } x { x := shr(8, x) } { l := add(l, 1) }
                mstore8(ptr, l)
                if l { mstore(add(ptr, 1), shl(mul(8, sub(32, l)), v)) }
                np := add(ptr, add(1, l))
            }
            // The low `nb` bytes of v (two's complement for negatives), big-endian.
            function putFixed(ptr, v, nb) -> np {
                mstore(ptr, shl(mul(8, sub(32, nb)), v))
                np := add(ptr, nb)
            }

            let out := mload(0x40)
            let w := add(out, 0x20)
            // u64 block number
            mstore(w, shl(192, number()))
            w := add(w, 8)
            let n := div(pools.length, 20)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let pool := shr(96, calldataload(add(pools.offset, mul(i, 20))))
                let flag := w
                mstore8(flag, 0)
                w := add(w, 1)

                // slot0() -> (sqrtPriceX96, tick, ...)
                mstore(0x00, shl(224, 0x3850c7bd))
                let ok := staticcall(gas(), pool, 0x00, 4, 0x00, 0x40)
                if lt(returndatasize(), 0x40) { ok := 0 }
                if iszero(ok) { continue }
                let sqrtP := mload(0x00)
                let tick := signextend(2, mload(0x20))
                if iszero(sqrtP) { continue }
                // liquidity()
                mstore(0x00, shl(224, 0x1a686502))
                let liq := 0
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { liq := mload(0x00) }
                }
                // fee()
                mstore(0x00, shl(224, 0xddca3f43))
                let fee := 0
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { fee := mload(0x00) }
                }
                // tickSpacing()
                mstore(0x00, shl(224, 0xd0c93a7c))
                let spacing := 0
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { spacing := signextend(2, mload(0x00)) }
                }
                if iszero(sgt(spacing, 0)) { continue }

                mstore8(flag, 1)
                w := putVar(w, sqrtP)
                w := putFixed(w, tick, 3)
                w := putVar(w, liq)
                w := putFixed(w, fee, 3)
                w := putFixed(w, spacing, 3)
                let countAt := w
                w := add(w, 2)

                let c := sdiv(tick, spacing)
                if and(slt(tick, 0), iszero(iszero(smod(tick, spacing)))) { c := sub(c, 1) }
                let w0 := sar(8, c)
                let count := 0
                for { let wp := sub(w0, words) } iszero(sgt(wp, add(w0, words))) { wp := add(wp, 1) } {
                    if slt(wp, sub(0, 32768)) { continue }
                    if sgt(wp, 32767) { break }
                    mstore(0x00, shl(224, 0x5339c296))
                    mstore(0x04, wp)
                    let bm := 0
                    if staticcall(gas(), pool, 0x00, 0x24, 0x00, 0x20) {
                        if iszero(lt(returndatasize(), 0x20)) { bm := mload(0x00) }
                    }
                    for { let b := 0 } and(lt(b, 256), iszero(iszero(shr(b, bm)))) { } {
                        if iszero(and(shr(b, bm), 0xff)) { b := add(b, 8) continue }
                        if and(shr(b, bm), 1) {
                            let t := mul(add(shl(8, wp), b), spacing)
                            mstore(0x00, shl(224, 0xf30dba93))
                            mstore(0x04, t)
                            let net := 0
                            if staticcall(gas(), pool, 0x00, 0x24, 0x00, 0x40) {
                                if iszero(lt(returndatasize(), 0x40)) { net := signextend(15, mload(0x20)) }
                            }
                            w := putFixed(w, t, 3)
                            w := putFixed(w, net, 16)
                            count := add(count, 1)
                        }
                        b := add(b, 1)
                    }
                }
                // u16 count, written over its reserved slot without disturbing what follows
                mstore8(countAt, and(shr(8, count), 0xff))
                mstore8(add(countAt, 1), and(count, 0xff))
            }
            // ABI-encode `bytes` in place and return: [0x20][len][data][zero pad].
            // The word before `out` belongs to memory nothing will read again.
            let len := sub(w, add(out, 0x20))
            mstore(out, len)
            mstore(w, 0)
            mstore(sub(out, 0x20), 0x20)
            return(sub(out, 0x20), add(0x40, and(add(len, 31), not(31))))
        }
    }

    /// Packed getAlgebraState: byte-for-byte the getV3StatePacked layout, for
    /// Algebra pools (V1 / Integral). Differs from getV3StatePacked only in the
    /// three reads getAlgebraState (YoBatches2) documents — globalState() for
    /// price+tick+fee, and tickTable() for the bitmap — so the client decodes it
    /// with the same reader as getV3StatePacked.
    function getAlgebraStatePacked(bytes calldata pools, uint256 words) external view returns (bytes memory) {
        assembly {
            function putVar(ptr, v) -> np {
                let l := 0
                for { let x := v } x { x := shr(8, x) } { l := add(l, 1) }
                mstore8(ptr, l)
                if l { mstore(add(ptr, 1), shl(mul(8, sub(32, l)), v)) }
                np := add(ptr, add(1, l))
            }
            function putFixed(ptr, v, nb) -> np {
                mstore(ptr, shl(mul(8, sub(32, nb)), v))
                np := add(ptr, nb)
            }

            let out := mload(0x40)
            let w := add(out, 0x20)
            mstore(w, shl(192, number()))
            w := add(w, 8)
            let n := div(pools.length, 20)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let pool := shr(96, calldataload(add(pools.offset, mul(i, 20))))
                let flag := w
                mstore8(flag, 0)
                w := add(w, 1)

                // globalState() -> (uint160 price, int24 tick, uint16 fee, ...)
                mstore(0x00, shl(224, 0xe76c01e4))
                let ok := staticcall(gas(), pool, 0x00, 4, 0x00, 0x60)
                if lt(returndatasize(), 0x60) { ok := 0 }
                if iszero(ok) { continue }
                let sqrtP := mload(0x00)
                let tick := signextend(2, mload(0x20))
                let fee := and(mload(0x40), 0xffff)
                if iszero(sqrtP) { continue }
                // fee(): live fee (Integral plugin) beats globalState's lastFee;
                // keep lastFee if the pool has no fee() (V1). See YoBatches2.
                mstore(0x00, shl(224, 0xddca3f43))
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { fee := and(mload(0x00), 0xffffff) }
                }
                // liquidity()
                mstore(0x00, shl(224, 0x1a686502))
                let liq := 0
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { liq := mload(0x00) }
                }
                // tickSpacing()
                mstore(0x00, shl(224, 0xd0c93a7c))
                let spacing := 0
                if staticcall(gas(), pool, 0x00, 4, 0x00, 0x20) {
                    if iszero(lt(returndatasize(), 0x20)) { spacing := signextend(2, mload(0x00)) }
                }
                if iszero(sgt(spacing, 0)) { continue }

                mstore8(flag, 1)
                w := putVar(w, sqrtP)
                w := putFixed(w, tick, 3)
                w := putVar(w, liq)
                w := putFixed(w, fee, 3)
                w := putFixed(w, spacing, 3)
                let countAt := w
                w := add(w, 2)

                let c := sdiv(tick, spacing)
                if and(slt(tick, 0), iszero(iszero(smod(tick, spacing)))) { c := sub(c, 1) }
                let w0 := sar(8, c)
                let count := 0
                for { let wp := sub(w0, words) } iszero(sgt(wp, add(w0, words))) { wp := add(wp, 1) } {
                    if slt(wp, sub(0, 32768)) { continue }
                    if sgt(wp, 32767) { break }
                    mstore(0x00, shl(224, 0xc677e3e0))   // tickTable(int16)
                    mstore(0x04, wp)
                    let bm := 0
                    if staticcall(gas(), pool, 0x00, 0x24, 0x00, 0x20) {
                        if iszero(lt(returndatasize(), 0x20)) { bm := mload(0x00) }
                    }
                    for { let b := 0 } and(lt(b, 256), iszero(iszero(shr(b, bm)))) { } {
                        if iszero(and(shr(b, bm), 0xff)) { b := add(b, 8) continue }
                        if and(shr(b, bm), 1) {
                            let t := mul(add(shl(8, wp), b), spacing)
                            mstore(0x00, shl(224, 0xf30dba93))   // ticks(int24)
                            mstore(0x04, t)
                            let net := 0
                            if staticcall(gas(), pool, 0x00, 0x24, 0x00, 0x40) {
                                if iszero(lt(returndatasize(), 0x40)) { net := signextend(15, mload(0x20)) }
                            }
                            w := putFixed(w, t, 3)
                            w := putFixed(w, net, 16)
                            count := add(count, 1)
                        }
                        b := add(b, 1)
                    }
                }
                mstore8(countAt, and(shr(8, count), 0xff))
                mstore8(add(countAt, 1), and(count, 0xff))
            }
            let len := sub(w, add(out, 0x20))
            mstore(out, len)
            mstore(w, 0)
            mstore(sub(out, 0x20), 0x20)
            return(sub(out, 0x20), add(0x40, and(add(len, 31), not(31))))
        }
    }
}
