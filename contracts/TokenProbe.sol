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

/// Balancer V2 Vault: lends, calls receiveFlashLoan, checks its balance after.
interface IProbeBalancerVault {
    function flashLoan(address recipient, address[] calldata tokens, uint256[] calldata amounts, bytes calldata userData) external;
}

/// Uniswap V3 pool (and its PancakeV3 / Algebra cousins): flash -> *FlashCallback.
interface IProbeV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

/// Morpho Blue singleton (and settlement layers built on it, e.g. Longbow):
/// lends any token it holds, calls onMorphoFlashLoan, pulls repayment after.
interface IProbeMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
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
///
/// LENDERS. probeFrom() borrows from any lender FlashArbExecutor can borrow
/// from, with the executor's SOURCE ids, so `yarn probe` works on every chain
/// the bot trades — not only chains with Aave:
///   0  Aave V3          flashLoanSimple -> executeOperation
///   1  Balancer V2      flashLoan       -> receiveFlashLoan
///   2  Uniswap V3 pool  flash           -> uniswapV3FlashCallback (+ Pancake / Algebra spellings)
///   3  Morpho Blue      flashLoan       -> onMorphoFlashLoan       (Longbow on Robinhood Chain)
/// probe() is the original Aave-only entry point, kept so older clients work.
/// Nothing is ever repaid: every callback ends in a revert, so no lender is
/// ever left short — the whole eth_call unwinds.
contract TokenProbe {
    address public immutable aavePool;

    uint8 public constant SOURCE_AAVE_V3     = 0;
    uint8 public constant SOURCE_BALANCER_V2 = 1;
    uint8 public constant SOURCE_UNISWAP_V3  = 2;
    uint8 public constant SOURCE_MORPHO      = 3;

    /// The lender the current probe borrows from; the one callback admitted.
    /// Storage, not transient: the call always reverts, so it never persists.
    address private _lender;

    uint8 internal constant STAGE_NO_CODE       = 0; // token address has no bytecode
    uint8 internal constant STAGE_FUND_PAIR     = 1; // root.transfer(pair)
    uint8 internal constant STAGE_BUY_SWAP      = 2; // pair.swap -> token to this contract
    uint8 internal constant STAGE_SELL_TRANSFER = 3; // token.transfer(pair) from this contract
    uint8 internal constant STAGE_SELL_SWAP     = 4; // pair.swap -> root to this contract
    uint8 internal constant STAGE_NO_CALLBACK   = 5; // the lender returned without calling back

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
    error NoLender();
    error BadSource(uint8 source);
    error TokenNotInLender();

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

    /// @notice Original entry point: borrow from the constructor's Aave pool.
    /// @param root       Flash-loanable token that is one side of `pair`
    /// @param amount     Root amount to borrow and push through the pair
    /// @param pair       V2-style pair: root / token-under-test
    /// @param feeBpsCap  Conservative fee assumption for sizing (e.g. 200 = 2%)
    function probe(address root, uint256 amount, address pair, uint16 feeBpsCap) external {
        _borrow(SOURCE_AAVE_V3, aavePool, root, amount, pair, feeBpsCap);
    }

    /// @notice Borrow `root` from any supported lender, then probe `pair`.
    /// @param source  SOURCE_* (same ids as FlashArbExecutor)
    /// @param lender  Aave pool / Balancer vault / V3 pool holding root / Morpho singleton
    function probeFrom(uint8 source, address lender, address root, uint256 amount, address pair, uint16 feeBpsCap) external {
        _borrow(source, lender, root, amount, pair, feeBpsCap);
    }

    function _borrow(uint8 source, address lender, address root, uint256 amount, address pair, uint16 feeBpsCap) internal {
        if (lender == address(0)) revert NoLender();
        bytes memory data = abi.encode(root, pair, feeBpsCap);
        _lender = lender;
        if (source == SOURCE_AAVE_V3) {
            IProbePool(lender).flashLoanSimple(address(this), root, amount, data, 0);
        } else if (source == SOURCE_BALANCER_V2) {
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0] = root;
            amounts[0] = amount;
            IProbeBalancerVault(lender).flashLoan(address(this), tokens, amounts, data);
        } else if (source == SOURCE_UNISWAP_V3) {
            bool zero = IProbeV3Pool(lender).token0() == root;
            if (!zero && IProbeV3Pool(lender).token1() != root) revert TokenNotInLender();
            IProbeV3Pool(lender).flash(address(this), zero ? amount : 0, zero ? 0 : amount, data);
        } else if (source == SOURCE_MORPHO) {
            IProbeMorpho(lender).flashLoan(root, amount, data);
        } else {
            revert BadSource(source);
        }
        // Unreachable: every callback reverts. A lender that returned without
        // calling back lands here, and that is a failure too.
        revert ProbeFailed(STAGE_NO_CALLBACK, "lender returned without calling back");
    }

    function _claim() internal view {
        if (_lender == address(0) || msg.sender != _lender) revert NotPool();
    }

    // ---- lender callbacks: each hands (root, amount, data) to _run ----------------

    /// Aave V3
    function executeOperation(address, uint256 amount, uint256, address initiator, bytes calldata params) external returns (bool) {
        _claim();
        if (initiator != address(this)) revert UntrustedInitiator();
        _run(amount, params);
    }

    /// Balancer V2
    function receiveFlashLoan(address[] calldata, uint256[] calldata amounts, uint256[] calldata, bytes calldata userData) external {
        _claim();
        _run(amounts[0], userData);
    }

    /// Uniswap V3 and spellings. The amount is the root balance we now hold.
    function uniswapV3FlashCallback(uint256, uint256, bytes calldata data) external { _v3(data); }
    function pancakeV3FlashCallback(uint256, uint256, bytes calldata data) external { _v3(data); }
    function algebraFlashCallback(uint256, uint256, bytes calldata data) external { _v3(data); }

    function _v3(bytes calldata data) internal {
        _claim();
        (address root, , ) = abi.decode(data, (address, address, uint16));
        _run(IProbeERC20(root).balanceOf(address(this)), data);
    }

    /// Morpho Blue
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        _claim();
        _run(assets, data);
    }

    /// The probe itself. Always reverts.
    function _run(uint256 amount, bytes calldata data) internal {
        (address root, address pair, uint16 feeBpsCap) = abi.decode(data, (address, address, uint16));
        Ctx memory c;
        c.root = root;
        c.pair = IProbePair(pair);
        c.feeBpsCap = feeBpsCap;
        c.rootIs0 = c.pair.token0() == root;
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
