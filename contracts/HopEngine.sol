// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20H {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IV2PairH {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IV3PoolH {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
}

/// @title HopEngine
/// @notice The swap-chain machinery of FlashArbExecutor, as a base contract, so
/// a second executor (LiquidationExecutor) runs exactly the same hop rules
/// instead of a re-implementation of them.
///
/// The code below is FlashArbExecutor's `_hop`, `_v2Quote`, `_v3Hop`,
/// `_v3Direction`, `_v3Swap`, swap callbacks and `_amountOut`, unchanged except
/// that the chain is funded from `hops[0].tokenIn` instead of a flash-loan root.
/// FlashArbExecutor itself is deliberately left as deployed (four chains, live
/// addresses) — see its header for the full rationale of each rule:
///
///   SIZING IS ON-CHAIN   V2 outputs come from live reserves and what actually
///                        arrived in the pair, so reserve drift and transfer
///                        taxes reduce output instead of reverting.
///   ROUTING              A hop sends its output straight to the next V2 pair,
///                        or here when the next hop is V3 or it is the last.
///   V3 CALLBACK SAFETY   The swap callback pays only the pool whose swap is in
///                        progress, once, in that hop's tokenIn, never more than
///                        the hop's input — pools come from unvetted factories.
abstract contract HopEngine {
    uint8 public constant HOP_V2 = 0;
    uint8 public constant HOP_V3 = 1;

    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE  = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    uint256 private constant FEE_SCALE = 1_000_000;

    address private _swapPool;
    address private _swapTokenIn;
    uint256 private _swapMaxIn;

    /// Same layout as FlashArbExecutor.Hop, so the off-chain hop builder's
    /// output is accepted by both contracts.
    struct Hop {
        address pair;
        address tokenIn;
        uint32  feePpm;
        address recipient;
        uint8   kind;
    }

    error EmptyHops();
    error BadFee(uint256 hop, uint32 feePpm);
    error NothingArrived(uint256 hop);
    error ZeroOutput(uint256 hop);
    error TokenNotInPair(uint256 hop);
    error BadHopKind(uint256 hop, uint8 kind);
    error BadRecipient(uint256 hop);
    error SwapOverpaid(uint256 owed, uint256 maxIn);
    error NotSwapPool();

    /// Run `hops` with `amountIn` of hops[0].tokenIn held by this contract.
    /// Output lands wherever the last hop's recipient says (normally here).
    function _runHops(Hop[] memory hops, uint256 amountIn) internal {
        uint256 len = hops.length;
        if (len == 0) revert EmptyHops();
        for (uint256 i = 0; i < len; i++) {
            uint8 k = hops[i].kind;
            if (k > HOP_V3) revert BadHopKind(i, k);
            if (k == HOP_V3 && i > 0 && hops[i - 1].recipient != address(this)) revert BadRecipient(i - 1);
        }

        uint256 held = amountIn;
        if (hops[0].kind == HOP_V2) {
            IERC20H(hops[0].tokenIn).transfer(hops[0].pair, amountIn);
            held = 0;
        }
        for (uint256 i = 0; i < len; i++) {
            bool feedsV3 = i + 1 < len && hops[i + 1].kind == HOP_V3;
            held = hops[i].kind == HOP_V3
                ? _v3Hop(hops[i], i, held, feedsV3)
                : _hop(hops[i], i, feedsV3);
        }
    }

    function _hop(Hop memory h, uint256 i, bool measure) internal returns (uint256 received) {
        (bool inIsToken0, uint256 amountOut) = _v2Quote(h, i);
        address tokenOut;
        uint256 before;
        if (measure) {
            tokenOut = inIsToken0 ? IV2PairH(h.pair).token1() : IV2PairH(h.pair).token0();
            before = IERC20H(tokenOut).balanceOf(address(this));
        }
        IV2PairH(h.pair).swap(inIsToken0 ? 0 : amountOut, inIsToken0 ? amountOut : 0, h.recipient, "");
        if (measure) received = IERC20H(tokenOut).balanceOf(address(this)) - before;
    }

    function _v2Quote(Hop memory h, uint256 i) internal view returns (bool inIsToken0, uint256 amountOut) {
        if (h.feePpm >= FEE_SCALE) revert BadFee(i, h.feePpm);
        inIsToken0 = IV2PairH(h.pair).token0() == h.tokenIn;
        (uint112 r0, uint112 r1, ) = IV2PairH(h.pair).getReserves();
        (uint256 reserveIn, uint256 reserveOut) = inIsToken0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (reserveIn == 0 || reserveOut == 0) revert TokenNotInPair(i);
        uint256 balIn = IERC20H(h.tokenIn).balanceOf(h.pair);
        if (balIn <= reserveIn) revert NothingArrived(i);
        amountOut = _amountOut(balIn - reserveIn, reserveIn, reserveOut, h.feePpm);
        if (amountOut == 0) revert ZeroOutput(i);
    }

    function _v3Hop(Hop memory h, uint256 i, uint256 amountIn, bool measure) internal returns (uint256 received) {
        if (amountIn == 0) revert NothingArrived(i);
        (bool zeroForOne, address tokenOut) = _v3Direction(h.pair, h.tokenIn, i);
        uint256 before = measure ? IERC20H(tokenOut).balanceOf(address(this)) : 0;
        if (_v3Swap(h, zeroForOne, amountIn) <= 0) revert ZeroOutput(i);
        if (measure) received = IERC20H(tokenOut).balanceOf(address(this)) - before;
    }

    function _v3Direction(address pool, address tokenIn, uint256 i) internal view returns (bool zeroForOne, address tokenOut) {
        address t0 = IV3PoolH(pool).token0();
        address t1 = IV3PoolH(pool).token1();
        if (tokenIn == t0) return (true, t1);
        if (tokenIn == t1) return (false, t0);
        revert TokenNotInPair(i);
    }

    function _v3Swap(Hop memory h, bool zeroForOne, uint256 amountIn) internal returns (int256 out) {
        _swapPool = h.pair;
        _swapTokenIn = h.tokenIn;
        _swapMaxIn = amountIn;
        (int256 a0, int256 a1) = IV3PoolH(h.pair).swap(
            h.recipient, zeroForOne, int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE, "");
        _swapPool = address(0);
        out = zeroForOne ? -a1 : -a0;
    }

    /// @notice Uniswap V3 swap callback. Do not call directly.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _v3SwapPay(amount0Delta, amount1Delta);
    }

    /// @notice PancakeV3 spelling of the swap callback.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _v3SwapPay(amount0Delta, amount1Delta);
    }

    function _v3SwapPay(int256 amount0Delta, int256 amount1Delta) internal {
        address pool = _swapPool;
        if (pool == address(0) || msg.sender != pool) revert NotSwapPool();
        _swapPool = address(0);
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owedSigned <= 0) return;
        uint256 owed = uint256(owedSigned);
        uint256 maxIn = _swapMaxIn;
        if (owed > maxIn) revert SwapOverpaid(owed, maxIn);
        IERC20H(_swapTokenIn).transfer(pool, owed);
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint32 feePpm) internal pure returns (uint256) {
        uint256 inAfterFee = amountIn * (FEE_SCALE - uint256(feePpm));
        return (inAfterFee * reserveOut) / (reserveIn * FEE_SCALE + inAfterFee);
    }
}
