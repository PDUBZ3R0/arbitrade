// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 interface
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

// ---- flash-loan sources ------------------------------------------------------

/// @notice Aave V3 pool — single-asset flash loan entrypoint. Repaid by
/// allowance: the pool pulls amount + premium after executeOperation returns.
interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// @notice Balancer V2 Vault. Repaid by transfer back to the vault before
/// receiveFlashLoan returns. Fee is the protocol flash-loan fee (0 on most
/// deployments; `yarn add-chain` reads it on-chain).
interface IBalancerVault {
    function flashLoan(address recipient, address[] calldata tokens, uint256[] calldata amounts, bytes calldata userData)
        external;
}

/// @notice Uniswap V3 pool (and forks: PancakeV3, Algebra). Repaid by transfer
/// back to the pool before the flash callback returns. Fee is the pool's fee
/// tier. The lending pool is LOCKED for the duration, so it must not also be a
/// hop in the cycle.
interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

/// @notice Morpho Blue. Free; repaid by allowance — Morpho pulls `assets`
/// after onMorphoFlashLoan returns.
interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// @notice Standard V2-style pair interface. Covers v2, v2fee, and solidly
/// factory families from the DEX pattern registry — the fee differs per pair
/// but the swap() and getReserves() surface does not.
interface IUniswapV2Pair {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
}

/// @title FlashArbExecutor
/// @notice Executes a cycle of optimistic V2-style swaps funded by a flash
/// loan. Each hop sends its output straight to the next pair (no intermediate
/// custody) and the final hop returns the root asset here for repayment.
///
/// FLASH SOURCES. The loan can come from any of four lenders, chosen per call
/// by the owner (`executeArbFrom`), so one deployment serves a chain whatever
/// lending it has:
///
///   0  Aave V3          flashLoanSimple -> executeOperation        (premium, ~0.05%)
///   1  Balancer V2      flashLoan       -> receiveFlashLoan        (usually free)
///   2  Uniswap V3 pool  flash           -> uniswapV3FlashCallback  (the pool's fee tier;
///                                          pancakeV3 / algebra spellings accepted)
///   3  Morpho Blue      flashLoan       -> onMorphoFlashLoan       (free)
///
/// `executeArb` (no source argument) still borrows from the constructor's Aave
/// pool, so existing callers keep working. Deploy with address(0) on a chain
/// without Aave; executeArb then reverts NoLender and executeArbFrom is the way in.
///
/// CALLBACK SAFETY. A flash callback is an external function anyone can call.
/// Each one accepts exactly one caller: the lender named by the owner's own
/// executeArb* call, during that call, once. `_lender` is set just before the
/// loan is requested and cleared on first use (and again after the loan
/// returns), so a callback from any other address — or a second callback from
/// the right one, or one arriving outside an owner call — reverts NotPool.
/// Aave's callback additionally checks the loan was initiated by this contract.
///
/// SIZING IS ON-CHAIN. This is the central design decision and it replaces an
/// earlier version that took precomputed amount0Out/amount1Out from the
/// caller. That version could not tolerate the reserves moving by a single wei
/// between the off-chain quote and execution: the pair's K invariant would
/// reject the now-too-large output request and revert the entire transaction.
/// On a 2-second chain, against actively traded pairs, that race is the normal
/// case rather than the exception, and the failure mode is maximally bad — you
/// pay gas and the trade does not happen.
///
/// Computing each hop's output here, from the pair's live reserves and the
/// amount that actually arrived, makes two whole classes of failure stop
/// mattering:
///
///   1. Reserve drift. Someone else trading the pair between our quote and our
///      execution now reduces our profit instead of reverting us.
///   2. Fee-on-transfer tokens. We measure what the pair actually received
///      (balanceOf - storedReserve) rather than what we sent, so a transfer
///      tax is absorbed into a smaller — but valid — output request.
///
/// What protects the trade instead is `minProfit`, checked once at the end
/// against the real balance. Drift and taxes can only erode profit down to
/// that floor; below it the whole transaction reverts and nothing is spent but
/// gas. The off-chain evaluator still picks WHICH cycle to try and at what
/// size; it no longer has to be right about the exact amounts.
contract FlashArbExecutor {
    address public immutable owner;
    /// Lender for `executeArb` (Aave V3). address(0) on chains without Aave.
    address public immutable aavePool;

    uint8 public constant SOURCE_AAVE_V3     = 0;
    uint8 public constant SOURCE_BALANCER_V2 = 1;
    uint8 public constant SOURCE_UNISWAP_V3  = 2;
    uint8 public constant SOURCE_MORPHO      = 3;

    /// The only address allowed to call a flash callback, and only once, while
    /// an executeArb* call is in progress. Plain storage rather than transient
    /// so the contract also deploys on chains without Cancun opcodes.
    address private _lender;

    /// Fee scale: parts per million. The DEX registry carries fees as decimals
    /// (0.003, 0.0035, 0.00195, 0.0025) and basis points cannot represent all
    /// of them — 0.00195 is 19.5 bps. 1e6 covers every fee the fee-verifier
    /// has recovered, with room to spare.
    uint256 private constant FEE_SCALE = 1_000_000;

    /// @param pair      V2-style pair for this hop
    /// @param tokenIn   Token being sent INTO this pair. Swap direction is
    ///                  derived from pair.token0() rather than carried
    ///                  alongside, so the two can never disagree.
    /// @param feePpm    This pair's fee in parts per million (0.3% = 3000)
    /// @param recipient Next pair in the chain, or this contract on the last hop
    struct Hop {
        address pair;
        address tokenIn;
        uint32  feePpm;
        address recipient;
    }

    /// @notice Emitted on every successful arb, carrying the profit as
    /// measured on-chain. The off-chain caller's predicted profit is an upper
    /// bound — drift and transfer taxes can only reduce it — so anything that
    /// records realised P&L must use this number and not the prediction.
    /// `premium` is whatever the lender charged (0 for Balancer V2 / Morpho).
    event ArbExecuted(
        address indexed asset,
        uint256 amountBorrowed,
        uint256 premium,
        uint256 profit
    );

    error NotOwner();
    error NotPool();
    error UntrustedInitiator();
    error InsufficientRepay(uint256 balance, uint256 required);
    error EmptyHops();
    error BadFee(uint256 hop, uint32 feePpm);
    error NothingArrived(uint256 hop);
    error ZeroOutput(uint256 hop);
    error TokenNotInPair(uint256 hop);
    error BadSource(uint8 source);
    error NoLender();
    error AssetMismatch();
    error TokenNotInLender();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _aavePool) {
        owner = msg.sender;
        aavePool = _aavePool;
    }

    // ---- entry points -----------------------------------------------------------

    /// @notice Aave-funded arb through the constructor's pool. Owner-only.
    /// @param asset Root token to borrow — the cycle's start/end token
    /// @param amount Amount to borrow, in asset's native units
    /// @param minProfit Minimum profit over the flash-loan repayment, in
    ///        asset's units. Enforced on-chain against the real closing
    ///        balance. Pass the floor you are willing to pay gas for; the
    ///        transaction reverts rather than settling for less.
    /// @param hops Ordered swap chain; hops[0].tokenIn must be `asset`
    function executeArb(
        address asset,
        uint256 amount,
        uint256 minProfit,
        Hop[] calldata hops
    ) external onlyOwner {
        _start(SOURCE_AAVE_V3, aavePool, asset, amount, minProfit, hops);
    }

    /// @notice Arb funded by any supported lender. Owner-only.
    /// @param source One of the SOURCE_* constants
    /// @param lender The Aave pool / Balancer vault / Uniswap V3 pool / Morpho
    ///        contract to borrow from. For SOURCE_UNISWAP_V3 the pool must hold
    ///        `asset` and must NOT be one of the hops (it is locked mid-flash).
    function executeArbFrom(
        uint8 source,
        address lender,
        address asset,
        uint256 amount,
        uint256 minProfit,
        Hop[] calldata hops
    ) external onlyOwner {
        _start(source, lender, asset, amount, minProfit, hops);
    }

    function _start(
        uint8 source,
        address lender,
        address asset,
        uint256 amount,
        uint256 minProfit,
        Hop[] calldata hops
    ) internal {
        if (hops.length == 0) revert EmptyHops();
        if (lender == address(0)) revert NoLender();
        bytes memory params = abi.encode(hops, asset, minProfit);

        _lender = lender;
        if (source == SOURCE_AAVE_V3) {
            IAavePool(lender).flashLoanSimple(address(this), asset, amount, params, 0);
        } else if (source == SOURCE_BALANCER_V2) {
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0] = asset;
            amounts[0] = amount;
            IBalancerVault(lender).flashLoan(address(this), tokens, amounts, params);
        } else if (source == SOURCE_UNISWAP_V3) {
            bool zero = IUniswapV3Pool(lender).token0() == asset;
            if (!zero && IUniswapV3Pool(lender).token1() != asset) revert TokenNotInLender();
            IUniswapV3Pool(lender).flash(
                address(this), zero ? amount : 0, zero ? 0 : amount, abi.encode(zero, amount, params));
        } else if (source == SOURCE_MORPHO) {
            IMorpho(lender).flashLoan(asset, amount, params);
        } else {
            revert BadSource(source);
        }
        _lender = address(0);
    }

    /// Admit exactly one callback, from the lender this call is borrowing from.
    function _claimLender() internal returns (address lender) {
        lender = _lender;
        if (lender == address(0) || msg.sender != lender) revert NotPool();
        _lender = address(0);
    }

    // ---- callbacks ----------------------------------------------------------------

    /// @notice Aave V3 flash loan callback. Do not call directly.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        address lender = _claimLender();
        if (initiator != address(this)) revert UntrustedInitiator();
        _run(asset, amount, premium, params);
        IERC20(asset).approve(lender, amount + premium);
        return true;
    }

    /// @notice Balancer V2 flash loan callback. Do not call directly.
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        address lender = _claimLender();
        if (tokens.length != 1) revert AssetMismatch();
        _run(tokens[0], amounts[0], feeAmounts[0], userData);
        IERC20(tokens[0]).transfer(lender, amounts[0] + feeAmounts[0]);
    }

    /// @notice Uniswap V3 flash callback. Do not call directly.
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _v3Flash(fee0, fee1, data);
    }

    /// @notice PancakeV3 spelling of the V3 flash callback.
    function pancakeV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _v3Flash(fee0, fee1, data);
    }

    /// @notice Algebra spelling of the V3 flash callback.
    function algebraFlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _v3Flash(fee0, fee1, data);
    }

    function _v3Flash(uint256 fee0, uint256 fee1, bytes calldata data) internal {
        address lender = _claimLender();
        (bool zero, uint256 amount, bytes memory params) = abi.decode(data, (bool, uint256, bytes));
        address asset = zero ? IUniswapV3Pool(lender).token0() : IUniswapV3Pool(lender).token1();
        uint256 fee = zero ? fee0 : fee1;
        _run(asset, amount, fee, params);
        IERC20(asset).transfer(lender, amount + fee);
    }

    /// @notice Morpho Blue flash loan callback. Do not call directly.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        address lender = _claimLender();
        (, address asset, ) = abi.decode(data, (Hop[], address, uint256));
        _run(asset, assets, 0, data);
        IERC20(asset).approve(lender, assets);
    }

    // ---- the cycle ------------------------------------------------------------------

    /// Run the hops with `amount` of `asset` in hand and verify the closing
    /// balance covers amount + fee + minProfit. Repayment itself is the
    /// caller's job, because each lender wants it differently.
    function _run(address asset, uint256 amount, uint256 fee, bytes memory params) internal {
        (Hop[] memory hops, address rootAsset, uint256 minProfit) =
            abi.decode(params, (Hop[], address, uint256));
        if (asset != rootAsset) revert AssetMismatch();

        // Optimistic transfer: fund the first pair directly, V2-swap style.
        IERC20(rootAsset).transfer(hops[0].pair, amount);

        uint256 len = hops.length;
        for (uint256 i = 0; i < len; i++) {
            _hop(hops[i], i);
        }

        uint256 amountOwed = amount + fee;
        uint256 required = amountOwed + minProfit;
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal < required) revert InsufficientRepay(bal, required);

        emit ArbExecuted(asset, amount, fee, bal - amountOwed);
    }

    /// Execute one hop, sizing the output from live state.
    function _hop(Hop memory h, uint256 i) internal {
        if (h.feePpm >= FEE_SCALE) revert BadFee(i, h.feePpm);

        bool inIsToken0 = IUniswapV2Pair(h.pair).token0() == h.tokenIn;
        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(h.pair).getReserves();
        (uint256 reserveIn, uint256 reserveOut) =
            inIsToken0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        // If tokenIn is neither side, token0() != tokenIn would still pass as
        // "it must be token1" — so verify there is actually a reserve to swap
        // against. A pair with a zero reserve is unswappable anyway.
        if (reserveIn == 0 || reserveOut == 0) revert TokenNotInPair(i);

        // What the pair ACTUALLY received, not what the previous step sent.
        // V2 updates its stored reserves only at the end of swap(), so until
        // then getReserves() is the pre-transfer state and the difference is
        // our (possibly taxed) input.
        uint256 balIn = IERC20(h.tokenIn).balanceOf(h.pair);
        if (balIn <= reserveIn) revert NothingArrived(i);
        uint256 amountIn = balIn - reserveIn;

        uint256 amountOut = _amountOut(amountIn, reserveIn, reserveOut, h.feePpm);
        if (amountOut == 0) revert ZeroOutput(i);

        IUniswapV2Pair(h.pair).swap(
            inIsToken0 ? 0 : amountOut,
            inIsToken0 ? amountOut : 0,
            h.recipient,
            ""
        );
    }

    /// Constant-product output, net of fee. Same form as the on-chain V2
    /// router, so the pair's own K check cannot disagree with it.
    ///
    /// Overflow: reserves are uint112 (max ~5.2e33) and amountIn is bounded by
    /// the pair's balance, so amountIn * FEE_SCALE tops out around 5.2e39 and
    /// the numerator around 2.7e73 — both inside uint256 (~1.2e77).
    function _amountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint32 feePpm
    ) internal pure returns (uint256) {
        uint256 inAfterFee = amountIn * (FEE_SCALE - uint256(feePpm));
        return (inAfterFee * reserveOut) / (reserveIn * FEE_SCALE + inAfterFee);
    }

    /// @notice Sweep residual balance (profit, or anything stuck) to owner.
    function sweep(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(owner, bal);
    }
}
