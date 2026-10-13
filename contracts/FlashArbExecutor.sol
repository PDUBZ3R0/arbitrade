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
    /// Also the swap surface for HOP_V3 hops (Uniswap V3 and PancakeV3 share it;
    /// only the callback's name differs).
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
}

/// @notice Morpho Blue. Free; repaid by allowance — Morpho pulls `assets`
/// after onMorphoFlashLoan returns.
interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// @notice Solidly-family pair (Solidly, Velodrome/Aerodrome, Equalizer, Ramses,
/// Camelot …): the pair quotes itself, for either curve, fee included. Its own
/// router swaps exactly this amount, so the pair's K check accepts it.
interface ISolidlyPair {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

/// @notice Standard V2-style pair interface. Covers v2, v2fee, and solidly
/// factory families from the DEX pattern registry — the fee differs per pair
/// but the swap() and getReserves() surface does not.
interface IUniswapV2Pair {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @title FlashArbExecutor
/// @notice Executes a cycle of swaps funded by a flash loan. Three hop kinds:
///
///   HOP_V2      V2-style pair (v2, v2fee, solidly volatile). Paid up front: its
///               input must already sit in the pair when the hop runs, and it is
///               sized here from live reserves (see SIZING below).
///   HOP_V3      Uniswap V3 / PancakeV3 pool. Paid in the swap callback: its input
///               must be HERE when the hop runs, and the pool itself sizes the
///               output (exact-input swap of everything we hold for the hop, no
///               price limit).
///   HOP_STABLE  Solidly-family STABLE pool (x³y + xy³ = k, decimals-normalised).
///               Paid up front and swapped exactly like HOP_V2 — same swap()
///               surface — but sized by the pair's own getAmountOut(amountIn,
///               tokenIn) instead of constant-product math: the stable curve has
///               no closed form, every fork iterates it slightly differently,
///               and the pair's own quote is the one its K check agrees with.
///
/// ROUTING follows from that. A hop sends its output straight to the next
/// hop's pair when the next hop is V2 or STABLE (no intermediate custody),
/// and to this contract when the next hop is V3 or when it is the last hop.
/// The off-chain builder sets `recipient` accordingly; the contract checks the
/// one case it cannot recover from (a V3 hop whose input went elsewhere).
///
/// PROFIT is measured against the balance this contract held BEFORE the loan,
/// so profit left here by earlier arbs (nothing sweeps automatically) can
/// never make a losing cycle pass the minProfit check.
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
/// FLASH SWAP (`executeFlashSwap`) needs no lender at all. When the first hop
/// is a V2-style pair, that pair IS the loan: it sends its output here first,
/// calls back, and is paid its input — the root token — at the end of the
/// cycle, before its own K check. The "fee" is the swap fee hop 0 charges
/// anyway, so there is no premium, no lender bookkeeping, and one fewer token
/// transfer. Every V2 fork calls back with the same
/// `(address sender, uint256, uint256, bytes)` arguments under a different
/// name (uniswapV2Call, pancakeCall, Solidly's hook, BiswapCall …); the common
/// ones are declared, and `fallback` accepts any other spelling, so no
/// per-factory callback table is needed. The callback is pinned to the exact
/// bytes this contract handed the pair (see FLASH SWAP SAFETY below).
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

    /// Hop kinds. HOP_V3 doubles as the version probe: an executor without it
    /// predates V3 hops, and the off-chain caller refuses to use it.
    uint8 public constant HOP_V2 = 0;
    uint8 public constant HOP_V3 = 1;
    /// Also a version probe: an executor without it cannot trade stable pools.
    uint8 public constant HOP_STABLE = 2;

    /// TickMath bounds, +1 / -1: a V3 swap with no effective price limit.
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE  = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// The only address allowed to call a flash callback, and only once, while
    /// an executeArb* call is in progress. Plain storage rather than transient
    /// so the contract also deploys on chains without Cancun opcodes.
    address private _lender;

    /// The V3 pool whose swap is in progress, the token it is owed and the
    /// most it may take. Set just before pool.swap(), cleared by the first
    /// callback. The cap matters: pools come from scanning factories nobody
    /// vetted, and an uncapped callback would let a hostile "pool" bill this
    /// contract for whatever it holds — including unswept profit.
    address private _swapPool;
    address private _swapTokenIn;
    uint256 private _swapMaxIn;

    /// Version probe for the off-chain caller: an executor without it cannot
    /// flash-swap and is driven through executeArbFrom only.
    bool public constant FLASH_SWAP = true;
    /// Version probe: executeFlashSwap also takes a concentrated-liquidity
    /// first hop (Uniswap V3 / PancakeV3 / Algebra) — the pool's swap is the loan.
    bool public constant V3_FLASH_SWAP = true;

    /// FLASH SWAP SAFETY. keccak256 of the exact `data` handed to the borrowed
    /// pair, set just before pair.swap() and cleared by the first callback.
    /// The pair echoes `data` back, and pairs come from factories nobody
    /// vetted — a hostile one could rewrite the repay amount, the baseline or
    /// minProfit on the way back. Matching the hash means every value the
    /// callback acts on is one this contract wrote, and the caller must be
    /// hops[0].pair, named inside that same data.
    bytes32 private _flashCtx;

    /// Fee scale: parts per million. The DEX registry carries fees as decimals
    /// (0.003, 0.0035, 0.00195, 0.0025) and basis points cannot represent all
    /// of them — 0.00195 is 19.5 bps. 1e6 covers every fee the fee-verifier
    /// has recovered, with room to spare.
    uint256 private constant FEE_SCALE = 1_000_000;

    /// @param pair      V2-style pair or V3 pool for this hop
    /// @param tokenIn   Token being sent INTO this pair. Swap direction is
    ///                  derived from pair.token0() rather than carried
    ///                  alongside, so the two can never disagree.
    /// @param feePpm    V2: this pair's fee in parts per million (0.3% = 3000).
    ///                  V3 / STABLE: informational only — the pool applies its own fee.
    /// @param recipient Next hop's pair when that hop is V2 or STABLE; this
    ///                  contract when the next hop is V3 or this is the last hop
    /// @param kind      HOP_V2, HOP_V3 or HOP_STABLE
    struct Hop {
        address pair;
        address tokenIn;
        uint32  feePpm;
        address recipient;
        uint8   kind;
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
    error BadHopKind(uint256 hop, uint8 kind);
    error BadRecipient(uint256 hop);
    error SwapOverpaid(uint256 owed, uint256 maxIn);
    error NoFlashCallback();

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
        // The loan funds hop 0. Enforced (it was only documented) now that
        // _cycle pays hop 0 in hops[0].tokenIn rather than in `asset`.
        if (hops[0].tokenIn != rootAsset) revert AssetMismatch();

        // Every lender has already transferred `amount` in. Anything beyond it
        // was here before this trade (unswept profit, dust) and is not ours to
        // count — see PROFIT in the contract header.
        uint256 baseline = IERC20(asset).balanceOf(address(this)) - amount;

        _validate(hops);
        _cycle(hops, 0, amount);

        uint256 amountOwed = amount + fee;
        uint256 required = amountOwed + minProfit;
        uint256 bal = IERC20(asset).balanceOf(address(this)) - baseline;
        if (bal < required) revert InsufficientRepay(bal, required);

        emit ArbExecuted(asset, amount, fee, bal - amountOwed);
    }

    function _validate(Hop[] memory hops) internal view {
        uint256 len = hops.length;
        for (uint256 i = 0; i < len; i++) {
            uint8 k = hops[i].kind;
            if (k > HOP_STABLE) revert BadHopKind(i, k);
            // A V3 hop is paid from this contract's balance, so whatever
            // feeds it must have sent its output here.
            if (k == HOP_V3 && i > 0 && hops[i - 1].recipient != address(this)) revert BadRecipient(i - 1);
        }
    }

    /// Run hops[from..] with `amount` of hops[from].tokenIn held HERE. Shared
    /// by the lender path (from = 0, the loan) and the flash-swap path
    /// (from = 1, what the borrowed pair sent).
    function _cycle(Hop[] memory hops, uint256 from, uint256 amount) internal {
        // `held` is how much of the current hop's tokenIn this contract holds
        // FOR that hop — only meaningful when the hop is V3. A V2 or STABLE
        // hop is funded optimistically, V2-swap style.
        uint256 held = amount;
        if (hops[from].kind != HOP_V3) {
            IERC20(hops[from].tokenIn).transfer(hops[from].pair, amount);
            held = 0;
        }

        uint256 len = hops.length;
        for (uint256 i = from; i < len; i++) {
            bool feedsV3 = i + 1 < len && hops[i + 1].kind == HOP_V3;
            held = hops[i].kind == HOP_V3
                ? _v3Hop(hops[i], i, held, feedsV3)
                : _hop(hops[i], i, feedsV3);
        }
    }

    // ---- flash swap -----------------------------------------------------------------

    /// @notice Arb funded by hop 0 itself: a flash swap. Owner-only.
    ///
    /// hops[0] HOP_V3: the pool's own swap is the loan — see _v3FlashStart.
    ///
    /// Otherwise hops[0] must be HOP_V2 or HOP_STABLE with recipient == this contract (a flash swap
    /// calls back whoever receives the output). Its output is sized here from
    /// live reserves for `amountIn` of hops[0].tokenIn, exactly as the router
    /// would, so repaying `amountIn` satisfies the pair's K check. hops[1..]
    /// run as usual inside the callback; the last hop must deliver the root
    /// token here.
    ///
    /// @param amountIn  Root token owed to hops[0].pair — the trade size
    /// @param minProfit Floor over `amountIn`, enforced on the real balance
    function executeFlashSwap(uint256 amountIn, uint256 minProfit, Hop[] calldata hops) external onlyOwner {
        if (hops.length < 2) revert EmptyHops();
        Hop calldata h0 = hops[0];
        if (h0.kind == HOP_V3) return _v3FlashStart(amountIn, minProfit, hops);
        if (h0.kind != HOP_V2 && h0.kind != HOP_STABLE) revert BadHopKind(0, h0.kind);
        if (h0.recipient != address(this)) revert BadRecipient(0);
        if (amountIn == 0) revert NothingArrived(0);

        (bool inIsToken0, address mid, uint256 out) = _flashQuote(h0, amountIn);
        if (hops[1].tokenIn != mid) revert TokenNotInPair(1);

        // Balances before anything arrives, so neither unswept profit in the
        // root token nor dust in the middle token can be counted as ours.
        bytes memory data = abi.encode(
            hops, amountIn, minProfit,
            IERC20(h0.tokenIn).balanceOf(address(this)),
            IERC20(mid).balanceOf(address(this))
        );
        _flashCtx = keccak256(data);
        IUniswapV2Pair(h0.pair).swap(inIsToken0 ? 0 : out, inIsToken0 ? out : 0, address(this), data);
        // A pair that never called back but did not revert either. Not a loss
        // (it paid out for nothing), but not a trade we understand: refuse.
        if (_flashCtx != bytes32(0)) revert NoFlashCallback();
    }

    /// Direction, the token hop 0 pays out, and how much of it `amountIn` buys
    /// at live reserves — the router's formula (the pair's own quote for a
    /// stable pool), so repaying `amountIn` passes K.
    function _flashQuote(Hop calldata h0, uint256 amountIn)
        internal view returns (bool inIsToken0, address mid, uint256 out)
    {
        if (h0.kind == HOP_V2 && h0.feePpm >= FEE_SCALE) revert BadFee(0, h0.feePpm);
        address t0 = IUniswapV2Pair(h0.pair).token0();
        address t1 = IUniswapV2Pair(h0.pair).token1();
        inIsToken0 = h0.tokenIn == t0;
        if (!inIsToken0 && h0.tokenIn != t1) revert TokenNotInPair(0);
        mid = inIsToken0 ? t1 : t0;

        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(h0.pair).getReserves();
        (uint256 reserveIn, uint256 reserveOut) =
            inIsToken0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (reserveIn == 0 || reserveOut == 0) revert TokenNotInPair(0);
        out = h0.kind == HOP_STABLE
            ? ISolidlyPair(h0.pair).getAmountOut(amountIn, h0.tokenIn)
            : _amountOut(amountIn, reserveIn, reserveOut, h0.feePpm);
        if (out == 0) revert ZeroOutput(0);
    }

    /// @notice Uniswap V2 flash-swap callback. Do not call directly.
    function uniswapV2Call(address sender, uint256, uint256, bytes calldata data) external {
        _flashSwapped(sender, data);
    }

    /// @notice PancakeSwap V2 spelling.
    function pancakeCall(address sender, uint256, uint256, bytes calldata data) external {
        _flashSwapped(sender, data);
    }

    /// @notice Solidly / Velodrome / Aerodrome spelling.
    function hook(address sender, uint256, uint256, bytes calldata data) external {
        _flashSwapped(sender, data);
    }

    /// Any other V2 fork's callback name (BiswapCall, apeCall, …). They all
    /// pass (address sender, uint256 amount0, uint256 amount1, bytes data).
    /// Anything else reaching here fails the _flashCtx check in _flashSwapped.
    fallback() external {
        if (_flashCtx == bytes32(0) || msg.data.length < 4 + 128) revert NotPool();
        (address sender, , , bytes memory data) = abi.decode(msg.data[4:], (address, uint256, uint256, bytes));
        _flashSwapped(sender, data);
    }

    function _flashSwapped(address sender, bytes memory data) internal {
        bytes32 ctx = _flashCtx;
        if (ctx == bytes32(0) || keccak256(data) != ctx) revert NotPool();
        _flashCtx = bytes32(0);
        if (sender != address(this)) revert UntrustedInitiator();

        (Hop[] memory hops, uint256 amountIn, uint256 minProfit, uint256 rootBefore, uint256 midBefore) =
            abi.decode(data, (Hop[], uint256, uint256, uint256, uint256));
        if (msg.sender != hops[0].pair) revert NotPool();
        _validate(hops);

        // What actually arrived, not what we asked for: a taxed middle token
        // delivers less, and hop 1 must not spend the difference.
        uint256 got = IERC20(hops[1].tokenIn).balanceOf(address(this)) - midBefore;
        if (got == 0) revert NothingArrived(0);
        _cycle(hops, 1, got);

        address root = hops[0].tokenIn;
        uint256 required = amountIn + minProfit;
        uint256 bal = IERC20(root).balanceOf(address(this)) - rootBefore;
        if (bal < required) revert InsufficientRepay(bal, required);

        // Pay hop 0 its input. It checks K when this returns. A taxed root
        // token underpays and the pair reverts — the off-chain side keeps
        // taxed tokens out of the root position.
        IERC20(root).transfer(hops[0].pair, amountIn);
        emit ArbExecuted(root, amountIn, 0, bal - amountIn);
    }

    // ---- V3 flash swap: a concentrated-liquidity first hop is the loan ---------------
    //
    // A V3-style pool already lends: swap() sends the output FIRST and only
    // then calls back for the input. So hop 0's output funds hops[1..] inside
    // that callback, and the pool is paid from the cycle's proceeds — no
    // lender, no premium, where borrowing the root from Aave cost 0.05%.
    //
    // Told apart from an ordinary V3 hop's callback by its data: ordinary hops
    // swap with empty data, this one with the encoded cycle, whose keccak256
    // is armed in _flashCtx (the same echo protection as the V2 flash swap).
    // Ordinary V3 hops inside the cycle use _swapPool/_swapMaxIn as always.

    function _v3FlashStart(uint256 amountIn, uint256 minProfit, Hop[] calldata hops) internal {
        Hop calldata h0 = hops[0];
        if (h0.recipient != address(this)) revert BadRecipient(0);
        if (amountIn == 0 || amountIn > uint256(type(int256).max)) revert NothingArrived(0);
        (bool zeroForOne, address mid) = _v3Direction(h0.pair, h0.tokenIn, 0);
        if (hops[1].tokenIn != mid) revert TokenNotInPair(1);

        bytes memory data = abi.encode(
            hops, amountIn, minProfit,
            IERC20(h0.tokenIn).balanceOf(address(this)),
            IERC20(mid).balanceOf(address(this))
        );
        _flashCtx = keccak256(data);
        IUniswapV3Pool(h0.pair).swap(
            address(this), zeroForOne, int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            data
        );
        if (_flashCtx != bytes32(0)) revert NoFlashCallback();
    }

    /// Hop 0's pool has paid out and is waiting to be paid: run the rest of
    /// the cycle, check the floor, pay the pool exactly what it asks (never
    /// more than amountIn).
    function _v3Flashed(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        bytes32 ctx = _flashCtx;
        if (ctx == bytes32(0) || keccak256(data) != ctx) revert NotPool();
        _flashCtx = bytes32(0);

        (Hop[] memory hops, uint256 amountIn, uint256 minProfit, uint256 rootBefore, uint256 midBefore) =
            abi.decode(data, (Hop[], uint256, uint256, uint256, uint256));
        if (msg.sender != hops[0].pair) revert NotPool();
        _validate(hops);

        uint256 got = IERC20(hops[1].tokenIn).balanceOf(address(this)) - midBefore;
        if (got == 0) revert NothingArrived(0);
        _cycle(hops, 1, got);

        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owedSigned <= 0) revert NothingArrived(0);
        uint256 owed = uint256(owedSigned);
        if (owed > amountIn) revert SwapOverpaid(owed, amountIn);

        address root = hops[0].tokenIn;
        uint256 required = owed + minProfit;
        uint256 bal = IERC20(root).balanceOf(address(this)) - rootBefore;
        if (bal < required) revert InsufficientRepay(bal, required);
        IERC20(root).transfer(msg.sender, owed);
        emit ArbExecuted(root, owed, 0, bal - owed);
    }

    /// Execute one V2 or STABLE hop, sizing the output from live state. Returns what
    /// arrived HERE when `measure` (the next hop is V3 and is paid from this
    /// contract), else 0.
    function _hop(Hop memory h, uint256 i, bool measure) internal returns (uint256 received) {
        (bool inIsToken0, uint256 amountOut) = _v2Quote(h, i);

        // Measured, not assumed: a taxed tokenOut delivers less than amountOut,
        // and the V3 hop that follows must not try to spend the difference.
        address tokenOut;
        uint256 before;
        if (measure) {
            tokenOut = inIsToken0 ? IUniswapV2Pair(h.pair).token1() : IUniswapV2Pair(h.pair).token0();
            before = IERC20(tokenOut).balanceOf(address(this));
        }

        IUniswapV2Pair(h.pair).swap(
            inIsToken0 ? 0 : amountOut,
            inIsToken0 ? amountOut : 0,
            h.recipient,
            ""
        );

        if (measure) received = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    /// Direction and output of a V2 or STABLE hop from the pair's live
    /// reserves and what actually arrived in it.
    function _v2Quote(Hop memory h, uint256 i) internal view returns (bool inIsToken0, uint256 amountOut) {
        if (h.kind == HOP_V2 && h.feePpm >= FEE_SCALE) revert BadFee(i, h.feePpm);

        inIsToken0 = IUniswapV2Pair(h.pair).token0() == h.tokenIn;
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

        // A stable pool quotes itself (stored reserves are still the
        // pre-transfer state, so this is exactly what its router would quote).
        amountOut = h.kind == HOP_STABLE
            ? ISolidlyPair(h.pair).getAmountOut(balIn - reserveIn, h.tokenIn)
            : _amountOut(balIn - reserveIn, reserveIn, reserveOut, h.feePpm);
        if (amountOut == 0) revert ZeroOutput(i);
    }

    /// Execute one V3 hop: exact-input swap of `amountIn` (what this contract
    /// holds for the hop), no price limit, paid in the swap callback. The
    /// final minProfit check is the guard against a moved price, as for V2.
    function _v3Hop(Hop memory h, uint256 i, uint256 amountIn, bool measure) internal returns (uint256 received) {
        if (amountIn == 0) revert NothingArrived(i);
        (bool zeroForOne, address tokenOut) = _v3Direction(h.pair, h.tokenIn, i);
        uint256 before = measure ? IERC20(tokenOut).balanceOf(address(this)) : 0;
        if (_v3Swap(h, zeroForOne, amountIn) <= 0) revert ZeroOutput(i);
        if (measure) received = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    function _v3Direction(address pool, address tokenIn, uint256 i) internal view returns (bool zeroForOne, address tokenOut) {
        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        if (tokenIn == t0) return (true, t1);
        if (tokenIn == t1) return (false, t0);
        revert TokenNotInPair(i);
    }

    /// Arm the callback for exactly this pool and input, swap, disarm. Returns
    /// the output the pool reports (positive).
    function _v3Swap(Hop memory h, bool zeroForOne, uint256 amountIn) internal returns (int256 out) {
        _swapPool = h.pair;
        _swapTokenIn = h.tokenIn;
        _swapMaxIn = amountIn;
        (int256 a0, int256 a1) = IUniswapV3Pool(h.pair).swap(
            h.recipient,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            ""
        );
        _swapPool = address(0); // a pool that never called back must not leave it armed
        out = zeroForOne ? -a1 : -a0;
    }

    // ---- V3 swap callbacks ----------------------------------------------------------

    /// @notice Uniswap V3 swap callback. Do not call directly.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3Callback(amount0Delta, amount1Delta, data);
    }

    /// @notice PancakeV3 spelling of the swap callback.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3Callback(amount0Delta, amount1Delta, data);
    }

    /// @notice Algebra (V1 / Integral) spelling of the swap callback. Algebra's
    /// swap() shares Uniswap's selector but calls back here; same pay semantics.
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3Callback(amount0Delta, amount1Delta, data);
    }

    /// Empty data: an ordinary V3 hop (_v3Swap). Anything else: the V3 flash
    /// swap's first hop — only accepted if it hashes to the armed _flashCtx.
    function _v3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        if (data.length == 0) _v3SwapPay(amount0Delta, amount1Delta);
        else _v3Flashed(amount0Delta, amount1Delta, data);
    }

    /// Pay the pool whose swap is in progress — once, in the hop's tokenIn, and
    /// never more than the hop's input.
    function _v3SwapPay(int256 amount0Delta, int256 amount1Delta) internal {
        address pool = _swapPool;
        if (pool == address(0) || msg.sender != pool) revert NotPool();
        _swapPool = address(0);
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owedSigned <= 0) return;
        uint256 owed = uint256(owedSigned);
        uint256 maxIn = _swapMaxIn;
        if (owed > maxIn) revert SwapOverpaid(owed, maxIn);
        IERC20(_swapTokenIn).transfer(pool, owed);
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
