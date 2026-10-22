// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISxERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISxPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// Uniswap V3, PancakeV3, Slipstream CL and Algebra all spell swap this way.
interface ISxCLPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
}

/// @title SniperExecutor
/// @notice sniper's real trades (~/Development/sniper, yarn live with live.trade on).
/// The money stays in the owner's wallet (sniper's hot wallet): a buy pulls its
/// stake from there (the owner approves this contract for each base, up to what
/// it is willing to trade), and a sell pays the proceeds straight back to it.
/// This contract only ever holds the tokens of open positions. Only the owner can
/// trade or withdraw, and withdrawals go to the owner.
///
/// buy() swaps the numeraire into a launch pool and, in the same transaction,
/// proves the WHOLE position sells: a call to itself sells everything just bought
/// and reverts with what it measured, so the sell is undone (no fees paid, the
/// tokens stay) but its verdict is known. The buy reverts unless that sell went
/// through with a tax under the cap. TokenProbe's verdict is from an eth_call a
/// block or more earlier; a token can switch selling off in between. A honeypot
/// at buy time costs the gas of a reverted transaction, not the stake.
///
/// The check is the whole amount, not a sample: a 1/1000 sliver passed on a BSC
/// token that refused anything more ("Anti-Dump: Max 25% purchase volume per 1
/// day allowed", a sniper fork test, 2026-10-19), which would have left the
/// position unsellable.
///
/// Pools are found by event topic alone (sniper survey / live), so a "pool" may
/// be any contract. What one can take is bounded by the stake: V2 gets exactly
/// amountIn pulled from the owner, and a CL pool's swap callback is paid at most
/// the amountIn of the swap in flight, only by the pool that swap was sent to.
/// Nothing else ever moves the owner's approved funds.
///
/// V2 sizes its output from the pair's reserves and `feeBps` (the pair's fee:
/// 30 for Uniswap V2 forks, 25 for PancakeSwap V2 — too low reverts the swap's K
/// check, too high only gets slightly less). Amounts that arrive are measured as
/// balance changes, so transfer taxes are paid and reported, never assumed.
contract SniperExecutor {
    address public immutable owner;

    uint160 internal constant MIN_SQRT_RATIO_PLUS_1 = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_1 = 1461446703485210103287273052203988822378723970341;

    uint8 internal constant STEP_BUY = 1;        // the buy swap
    uint8 internal constant STEP_CHECK = 2;      // the sell-check swap inside buy()
    uint8 internal constant STEP_SELL = 3;       // sell()
    uint8 internal constant STEP_TRANSFER = 4;   // a token transfer (into a pair, or paying a CL pool)

    /// The CL swap in flight: the only pool whose callback is paid, in what, and at most how much.
    address private _clPool;
    address private _clPay;
    uint256 private _clMax;
    bool private _clFromOwner;

    error NotOwner();
    error NotPool();
    error BadPool();
    error TooLittle(uint256 got, uint256 minOut);
    error SellCheck(uint256 sent, uint256 arrived, uint256 back, uint256 taxBps);
    error Failed(uint8 step, bytes reason);
    /// sellCheck's result, carried out by its own revert.
    error CheckResult(uint256 arrived, uint256 back);

    event Bought(address indexed token, address indexed pool, uint256 baseIn, uint256 tokensKept, uint256 checkSold, uint256 checkBack, uint256 sellTaxBps);
    event Sold(address indexed token, address indexed pool, uint256 tokensOut, uint256 arrived, uint256 baseBack);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        owner = owner_;
    }

    /// @dev One trade's parameters in memory: buy() with every local inline exceeds the
    /// EVM's 16-slot stack without viaIR (TokenProbe's Ctx, the same way).
    struct Trade {
        address pool;
        address base;
        address token;
        bool cl;
        uint16 feeBps;
    }

    /// @notice Buy `pool`'s other token with `amountIn` of `base` pulled from the owner (approved), then prove it sells.
    /// @return kept Tokens bought (all of them: the sell check is undone).
    function buy(address pool, bool cl, address base, uint256 amountIn, uint256 minOut, uint16 feeBps, uint16 maxSellTaxBps)
        external onlyOwner returns (uint256 kept)
    {
        Trade memory t = Trade(pool, base, _other(pool, base), cl, feeBps);
        uint256 before = _bal(t.token, address(this));
        if (cl) _clSwap(STEP_BUY, pool, base, amountIn, true);
        else _v2Swap(STEP_BUY, pool, base, amountIn, feeBps, true);
        uint256 got = _bal(t.token, address(this)) - before;
        if (got < minOut) revert TooLittle(got, minOut);
        kept = _check(t, got, amountIn, maxSellTaxBps);
    }

    /// The sell check: everything bought is sold in a call to ourselves that always reverts,
    /// so nothing of it stays; it must have come back with a tax under the cap.
    function _check(Trade memory t, uint256 got, uint256 amountIn, uint16 maxSellTaxBps) internal returns (uint256 kept) {
        (bool ok, bytes memory ret) = address(this).call(abi.encodeCall(this.sellCheck, (t.pool, t.cl, t.token, t.base, got, t.feeBps)));
        if (ok || ret.length < 4 || bytes4(ret) != CheckResult.selector) revert Failed(STEP_CHECK, ret);
        (uint256 arrived, uint256 back) = abi.decode(_tail(ret), (uint256, uint256));
        uint256 tax = arrived >= got ? 0 : ((got - arrived) * 10_000) / got;
        if (back == 0 || tax > maxSellTaxBps) revert SellCheck(got, arrived, back, tax);
        kept = got;
        emit Bought(t.token, t.pool, amountIn, kept, got, back, tax);
    }

    /// @notice buy()'s sell check: sells `amount` and reverts with what happened. Only this
    /// contract may call it, so it can never complete a sell for anyone.
    function sellCheck(address pool, bool cl, address token, address base, uint256 amount, uint16 feeBps) external {
        if (msg.sender != address(this)) revert NotOwner();
        (uint256 arrived, uint256 back) = _sell(STEP_CHECK, pool, cl, token, base, amount, feeBps);
        revert CheckResult(arrived, back);
    }

    /// Revert data without its 4-byte selector.
    function _tail(bytes memory b) internal pure returns (bytes memory out) {
        out = new bytes(b.length - 4);
        for (uint256 i = 0; i < out.length; i++) out[i] = b[i + 4];
    }

    /// @notice Sell `amount` of `pool`'s other token (held here) for `base`, paid to the owner.
    function sell(address pool, bool cl, address base, uint256 amount, uint256 minOut, uint16 feeBps)
        external onlyOwner returns (uint256 back)
    {
        address token = _other(pool, base);
        uint256 arrived;
        (arrived, back) = _sell(STEP_SELL, pool, cl, token, base, amount, feeBps);
        if (back < minOut) revert TooLittle(back, minOut);
        emit Sold(token, pool, amount, arrived, back);
    }

    /// @notice Send `amount` of `token` held here to the owner (type(uint256).max: all of it).
    function withdraw(address token, uint256 amount) external onlyOwner {
        if (amount == type(uint256).max) amount = _bal(token, address(this));
        _transfer(STEP_TRANSFER, token, owner, amount);
    }

    // ---- internals --------------------------------------------------------------------------

    function _other(address pool, address base) internal view returns (address) {
        address t0 = ISxPair(pool).token0();
        address t1 = ISxPair(pool).token1();
        if (t0 == base) return t1;
        if (t1 == base) return t0;
        revert BadPool();
    }

    /// Sell `amount` of `token` (held here) with the proceeds paid to the owner: how much of it
    /// the pool received, and how much `base` reached the owner.
    function _sell(uint8 step, address pool, bool cl, address token, address base, uint256 amount, uint16 feeBps)
        internal returns (uint256 arrived, uint256 back)
    {
        uint256 before = _bal(base, owner);
        if (cl) { _clSwap(step, pool, token, amount, false); arrived = amount; }   // a CL pool's balance check reverts a short (taxed) payment
        else arrived = _v2Swap(step, pool, token, amount, feeBps, false);
        back = _bal(base, owner) - before;
    }

    /// Push `amountIn` of `tokenIn` into a V2 pair and take what its reserves give for what arrived.
    /// A buy pays from the owner's wallet and receives here; a sell pays from here and the owner receives.
    function _v2Swap(uint8 step, address pair, address tokenIn, uint256 amountIn, uint16 feeBps, bool buying) internal returns (uint256 arrived) {
        bool in0 = ISxPair(pair).token0() == tokenIn;
        (uint112 r0, uint112 r1, ) = ISxPair(pair).getReserves();
        uint256 rIn = in0 ? uint256(r0) : uint256(r1);
        if (buying) _transferFrom(STEP_TRANSFER, tokenIn, owner, pair, amountIn);
        else _transfer(STEP_TRANSFER, tokenIn, pair, amountIn);
        uint256 bal = _bal(tokenIn, pair);
        arrived = bal > rIn ? bal - rIn : 0;
        _v2Take(step, pair, in0, _v2Out(arrived, rIn, in0 ? uint256(r1) : uint256(r0), feeBps), buying ? address(this) : owner);
    }

    function _v2Out(uint256 arrived, uint256 rIn, uint256 rOut, uint16 feeBps) internal pure returns (uint256) {
        uint256 inWithFee = arrived * (10_000 - uint256(feeBps));
        return (inWithFee * rOut) / (rIn * 10_000 + inWithFee);
    }

    function _v2Take(uint8 step, address pair, bool in0, uint256 out, address to) internal {
        (bool ok, bytes memory ret) = pair.call(abi.encodeCall(ISxPair.swap, (in0 ? 0 : out, in0 ? out : 0, to, bytes(""))));
        if (!ok) revert Failed(step, ret);
    }

    /// Exact-input swap of `amountIn` of `tokenIn` through a CL pool; its callback is paid below.
    /// A buy pays from the owner's wallet and receives here; a sell pays from here and the owner receives.
    function _clSwap(uint8 step, address pool, address tokenIn, uint256 amountIn, bool buying) internal {
        bool zeroForOne = ISxCLPool(pool).token0() == tokenIn;
        _clPool = pool; _clPay = tokenIn; _clMax = amountIn; _clFromOwner = buying;
        (bool ok, bytes memory ret) = pool.call(abi.encodeCall(ISxCLPool.swap,
            (buying ? address(this) : owner, zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO_PLUS_1 : MAX_SQRT_RATIO_MINUS_1, bytes(""))));
        _clPool = address(0); _clPay = address(0); _clMax = 0; _clFromOwner = false;
        if (!ok) revert Failed(step, ret);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external { _clPayOwed(d0, d1); }
    function pancakeV3SwapCallback(int256 d0, int256 d1, bytes calldata) external { _clPayOwed(d0, d1); }
    function algebraSwapCallback(int256 d0, int256 d1, bytes calldata) external { _clPayOwed(d0, d1); }

    function _clPayOwed(int256 d0, int256 d1) internal {
        if (_clPool == address(0) || msg.sender != _clPool) revert NotPool();
        uint256 owed = uint256(d0 > 0 ? d0 : d1);
        if (owed > _clMax) revert NotPool();   // never more than the swap in flight was for
        _clMax = 0;                            // and only once
        if (_clFromOwner) _transferFrom(STEP_TRANSFER, _clPay, owner, msg.sender, owed);
        else _transfer(STEP_TRANSFER, _clPay, msg.sender, owed);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return ISxERC20(token).balanceOf(who);
    }

    /// @dev transferFrom (the owner's approved funds), tolerant of no-return-value tokens.
    function _transferFrom(uint8 step, address token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(ISxERC20.transferFrom, (from, to, value)));
        if (!ok) revert Failed(step, ret);
        if (ret.length >= 32 && !abi.decode(ret, (bool))) revert Failed(step, "transferFrom returned false");
    }

    /// @dev ERC20 transfer tolerant of no-return-value tokens; a `false` return is a failure.
    function _transfer(uint8 step, address token, address to, uint256 value) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(ISxERC20.transfer, (to, value)));
        if (!ok) revert Failed(step, ret);
        if (ret.length >= 32 && !abi.decode(ret, (bool))) revert Failed(step, "transfer returned false");
    }
}
