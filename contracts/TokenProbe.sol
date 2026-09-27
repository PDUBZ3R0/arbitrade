// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interfaces (prefixed to avoid clashing with FlashArbExecutor's in the same compile unit)
interface IProbeERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IProbePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IProbePair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @title TokenProbe
/// @notice Honeypot / fee-on-transfer / restricted-pair detector. Flash-borrows
/// a small amount of a root token, buys the pair's other token, sells it back,
/// and measures exactly what arrived at every step.
///
/// THIS CONTRACT NEVER COMPLETES A CALL. Every path ends in a revert — either
/// ProbeResult (measurements) or ProbeFailed (which stage broke, and why). It
/// is meant to be invoked ONLY via eth_call; the flash loan is never repaid
/// because the whole call reverts, so it can never hold or move funds. Anyone
/// can call it; there is nothing to protect.
///
/// Swap sizes are computed with a caller-supplied CONSERVATIVE fee cap (e.g.
/// 200 bps) rather than the pair's real fee, so the pair's K-check passes for
/// any real fee <= cap without the probe needing to know the fee.
contract TokenProbe {
    address public immutable aavePool;

    uint8 internal constant STAGE_NO_CODE       = 0; // token address has no bytecode
    uint8 internal constant STAGE_FUND_PAIR     = 1; // root.transfer(pair)
    uint8 internal constant STAGE_BUY_SWAP      = 2; // pair.swap -> token to this contract
    uint8 internal constant STAGE_SELL_TRANSFER = 3; // token.transfer(pair) from this contract
    uint8 internal constant STAGE_SELL_SWAP     = 4; // pair.swap -> root to this contract

    /// @notice Successful round trip. Compare requested vs received to detect taxes.
    error ProbeResult(
        uint256 buyRequested,   // token amount we asked the pair to send us
        uint256 buyReceived,    // token amount that actually landed in this contract
        uint256 sellSent,       // token amount we transferred back to the pair
        uint256 sellArrived,    // token amount the pair's balance actually increased by
        uint256 rootRequested,  // root amount we asked for on the way back
        uint256 rootReceived    // root amount that actually landed
    );
    /// @notice A step reverted (or a transfer returned false). `reason` is the raw revert data.
    error ProbeFailed(uint8 stage, bytes reason);
    error NotPool();
    error UntrustedInitiator();

    constructor(address _aavePool) {
        aavePool = _aavePool;
    }

    /// @dev Per-probe context, passed by memory to keep each function's stack
    /// frame small (a single executeOperation with every local inline exceeds
    /// the EVM's 16-slot stack limit without viaIR).
    struct Ctx {
        address root;
        address token;
        IProbePair pair;
        bool rootIs0;
        uint16 feeBpsCap;
    }

    /// @param root       Flash-loanable token that is one side of `pair`
    /// @param amount     Root amount to borrow and push through the pair
    /// @param pair       V2-style pair: root / token-under-test
    /// @param feeBpsCap  Conservative fee assumption for sizing (e.g. 200 = 2%)
    function probe(address root, uint256 amount, address pair, uint16 feeBpsCap) external {
        IProbePool(aavePool).flashLoanSimple(address(this), root, amount, abi.encode(pair, feeBpsCap), 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256, /* premium — irrelevant, the call always reverts */
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != aavePool) revert NotPool();
        if (initiator != address(this)) revert UntrustedInitiator();

        (address pair, uint16 feeBpsCap) = abi.decode(params, (address, uint16));
        Ctx memory c;
        c.root = asset;
        c.pair = IProbePair(pair);
        c.feeBpsCap = feeBpsCap;
        c.rootIs0 = c.pair.token0() == asset;
        c.token = c.rootIs0 ? c.pair.token1() : c.pair.token0();
        if (c.token.code.length == 0) revert ProbeFailed(STAGE_NO_CODE, "token has no code");

        (uint256 buyRequested, uint256 buyReceived) = _buy(c, amount);
        (uint256 sellArrived, uint256 rootRequested, uint256 rootReceived) = _sell(c, buyReceived);
        revert ProbeResult(buyRequested, buyReceived, buyReceived, sellArrived, rootRequested, rootReceived);
    }

    /// Stages 1-2: push borrowed root into the pair, request the token out.
    function _buy(Ctx memory c, uint256 amount) internal returns (uint256 requested, uint256 received) {
        (uint256 rRoot, uint256 rTok) = _reserves(c);
        _transfer(STAGE_FUND_PAIR, c.root, address(c.pair), amount);
        requested = _amountOut(amount, rRoot, rTok, c.feeBpsCap);
        uint256 before = IProbeERC20(c.token).balanceOf(address(this));
        _call(STAGE_BUY_SWAP, address(c.pair), abi.encodeCall(IProbePair.swap,
            (c.rootIs0 ? 0 : requested, c.rootIs0 ? requested : 0, address(this), bytes(""))));
        received = IProbeERC20(c.token).balanceOf(address(this)) - before;
    }

    /// Stages 3-4: send everything received back to the pair, swap to root.
    function _sell(Ctx memory c, uint256 amount) internal returns (uint256 arrived, uint256 requested, uint256 received) {
        (uint256 rRoot, uint256 rTok) = _reserves(c);
        _transfer(STAGE_SELL_TRANSFER, c.token, address(c.pair), amount);
        uint256 pairBal = IProbeERC20(c.token).balanceOf(address(c.pair));
        arrived = pairBal > rTok ? pairBal - rTok : 0;
        requested = _amountOut(arrived, rTok, rRoot, c.feeBpsCap);
        uint256 before = IProbeERC20(c.root).balanceOf(address(this));
        _call(STAGE_SELL_SWAP, address(c.pair), abi.encodeCall(IProbePair.swap,
            (c.rootIs0 ? requested : 0, c.rootIs0 ? 0 : requested, address(this), bytes(""))));
        received = IProbeERC20(c.root).balanceOf(address(this)) - before;
    }

    function _reserves(Ctx memory c) internal view returns (uint256 rRoot, uint256 rTok) {
        (uint112 r0, uint112 r1, ) = c.pair.getReserves();
        (rRoot, rTok) = c.rootIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint16 feeBps) internal pure returns (uint256) {
        uint256 inWithFee = amountIn * (10_000 - uint256(feeBps));
        return (inWithFee * reserveOut) / (reserveIn * 10_000 + inWithFee);
    }

    function _call(uint8 stage, address target, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert ProbeFailed(stage, ret);
    }

    /// @dev ERC20 transfer tolerant of no-return-value tokens; a `false` return is a failure.
    function _transfer(uint8 stage, address token, address to, uint256 value) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IProbeERC20.transfer, (to, value)));
        if (!ok) revert ProbeFailed(stage, ret);
        if (ret.length >= 32 && !abi.decode(ret, (bool))) revert ProbeFailed(stage, "transfer returned false");
    }
}
