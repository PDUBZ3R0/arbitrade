// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HopEngine, IERC20H} from "./HopEngine.sol";

interface IAavePoolL {
    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
    function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external;
}

interface IBalancerVaultL {
    function flashLoan(address recipient, address[] calldata tokens, uint256[] calldata amounts, bytes calldata userData) external;
}

/// Morpho Blue: flash lender (SOURCE_MORPHO) AND liquidation venue.
interface IMorphoL {
    struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
    function liquidate(MarketParams memory marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes calldata data)
        external returns (uint256, uint256);
}

/// Compound III (Comet).
interface ICometL {
    function baseToken() external view returns (address);
    function absorb(address absorber, address[] calldata accounts) external;
    function buyCollateral(address asset, uint256 minAmount, uint256 baseAmount, address recipient) external;
    function quoteCollateral(address asset, uint256 baseAmount) external view returns (uint256);
    function getCollateralReserves(address asset) external view returns (uint256);
}

/// Compound V2 and forks (Benqi, Moonwell, Sonne, …). cTokens are ERC20.
interface ICErc20L {
    function liquidateBorrow(address borrower, uint256 repayAmount, address cTokenCollateral) external returns (uint256);
    function redeem(uint256 redeemTokens) external returns (uint256);
}

/// Euler V2: the Ethereum Vault Connector and an EVK vault.
interface IEVCL {
    struct BatchItem { address targetContract; address onBehalfOfAccount; uint256 value; bytes data; }
    function enableController(address account, address vault) external payable;
    function enableCollateral(address account, address vault) external payable;
    function batch(BatchItem[] calldata items) external payable;
}
interface IEVaultL {
    function liquidate(address violator, address collateral, uint256 repayAssets, uint256 minYieldBalance) external;
    function repay(uint256 amount, address receiver) external returns (uint256);
    function redeem(uint256 amount, address receiver, address owner) external returns (uint256);
    function disableController() external;
}

/// Fluid vault (tick-based, permissionless liquidate).
interface IFluidVaultL {
    function liquidate(uint256 debtAmt, uint256 colPerUnitDebt, address to, bool absorb)
        external payable returns (uint256 actualDebtAmt, uint256 actualColAmt);
}

/// @title LiquidationExecutor
/// @notice Liquidates unhealthy positions on Aave V3, Morpho Blue and Compound
/// III and keeps the liquidation incentive. Every entry point is one
/// all-or-nothing transaction that ends the same way: the debt/loan/base asset
/// balance must exceed what is owed by `minProfit`, measured against the
/// balance held BEFORE the call (unswept earlier profit cannot rescue a losing
/// liquidation), and the profit is both emitted (LiquidationExecuted — what the
/// ledger records) and RETURNED, so an eth_call tells the off-chain planner
/// exactly what a route would realise: the protocol's own incentive math, pool
/// slippage and transfer taxes, all at once.
///
/// AAVE V3 — liquidate():
///   1. flash-borrow `debtToCover` of the DEBT asset
///   2. pool.liquidationCall(collateral, debt, user, debtToCover, false) — Aave
///      pulls the debt (capped by close factor / collateral) and sends the
///      collateral at the liquidation bonus. What it actually pulled is read
///      back from the allowance; the unspent part goes back to the lender.
///   3. swap ALL seized collateral to the debt asset through `hops` (HopEngine:
///      the same on-chain-sized V2/V3 hops as FlashArbExecutor). Same-asset
///      positions (eMode loops) skip this.
///   4. require balance >= loan + fee + minProfit; repay the lender.
///
/// MORPHO BLUE — liquidateMorpho(): no flash loan needed. Morpho's liquidate()
/// sends the seized collateral FIRST, then calls onMorphoLiquidate(repaidAssets)
/// on us, then pulls the repayment. The callback swaps the collateral to the
/// loan token and approves exactly `repaidAssets`.
///
/// COMPOUND III — liquidateComet():
///   1. flash-borrow `baseAmount` of the Comet's BASE asset
///   2. comet.absorb([borrower]) when a borrower is given — tolerated if it
///      reverts (someone absorbed first: the collateral is in reserves anyway)
///   3. comet.buyCollateral(asset): spend the base needed for ALL of `asset` in
///      reserves (capped by the loan), at the store-front discount
///   4. swap the bought collateral back to base, check, repay.
///
/// FLASH SOURCES (Aave and Comet paths): Aave V3 (flashLoanSimple — the
/// liquidated pool itself works), Balancer V2, Morpho Blue. Callback rules as
/// in FlashArbExecutor: each callback accepts only the lender named by the
/// owner's own call, during that call, once — and onMorphoLiquidate only the
/// Morpho singleton this call is liquidating on.
contract LiquidationExecutor is HopEngine {
    address public immutable owner;

    uint8 public constant SOURCE_AAVE_V3     = 0;
    uint8 public constant SOURCE_BALANCER_V2 = 1;
    uint8 public constant SOURCE_MORPHO      = 3;

    uint8 private constant JOB_AAVE  = 0;
    uint8 private constant JOB_COMET = 1;
    uint8 private constant JOB_CV2   = 2;
    uint8 private constant JOB_FLUID = 3;

    /// @param pool        Aave V3 Pool holding the position
    /// @param user        Borrower being liquidated
    /// @param collateral  Collateral asset to seize
    /// @param debt        Debt asset to repay (and the asset profit is paid in)
    /// @param debtToCover Amount of `debt` to borrow and offer to Aave
    /// @param minProfit   Floor, in `debt` units, over loan + fee
    struct Liquidation {
        address pool;
        address user;
        address collateral;
        address debt;
        uint256 debtToCover;
        uint256 minProfit;
    }

    /// @param comet      The Comet
    /// @param borrower   Account to absorb first; address(0) to only buy reserves
    /// @param asset      Collateral asset to buy from reserves
    /// @param minProfit  Floor, in base units, over loan + fee
    struct CometJob {
        address comet;
        address borrower;
        address asset;
        uint256 minProfit;
    }

    event LiquidationExecuted(
        address indexed user,
        address indexed collateral,
        address indexed debt,
        uint256 debtRepaid,
        uint256 collateralSeized,
        uint256 premium,
        uint256 profit
    );

    error NotOwner();
    error NotPool();
    error UntrustedInitiator();
    error BadSource(uint8 source);
    error NoLender();
    error AssetMismatch();
    error RouteMismatch();
    error NothingSeized();
    error InsufficientRepay(uint256 balance, uint256 required);

    address private _lender;
    /// Morpho singleton whose liquidate() is in progress (callback guard).
    address private _morpho;
    /// EVC whose batch is in progress (onEulerLiquidate guard).
    address private _evc;
    uint256 private _profit;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ---- entry points ------------------------------------------------------------

    /// @notice Liquidate an Aave V3 position. Owner-only. Returns realised profit in debt units.
    /// @param source SOURCE_AAVE_V3 / SOURCE_BALANCER_V2 / SOURCE_MORPHO
    /// @param lender Contract to flash-borrow `l.debt` from
    /// @param hops   Collateral -> debt route (empty when collateral == debt);
    ///               hops[0].tokenIn must be the collateral, the last hop's
    ///               recipient this contract
    function liquidate(uint8 source, address lender, Liquidation calldata l, Hop[] calldata hops)
        external onlyOwner returns (uint256 profit)
    {
        _checkRoute(l.collateral, l.debt, hops);
        _flash(source, lender, l.debt, l.debtToCover, abi.encode(JOB_AAVE, abi.encode(l, hops)));
        profit = _takeProfit();
    }

    /// @param morpho        The Morpho Blue singleton
    /// @param borrower      Position owner
    /// @param seizedAssets  Collateral to seize — or 0 and set repaidShares
    /// @param repaidShares  Borrow shares to repay — or 0 and set seizedAssets
    /// @param minProfit     Floor, in loan-token units
    struct MorphoJob {
        address morpho;
        address borrower;
        uint256 seizedAssets;
        uint256 repaidShares;
        uint256 minProfit;
    }

    /// @notice Liquidate a Morpho Blue position. Owner-only. Exactly one of
    /// seizedAssets / repaidShares is non-zero (Morpho's rule). Returns realised
    /// profit in loan-token units.
    function liquidateMorpho(MorphoJob calldata j, IMorphoL.MarketParams calldata mp, Hop[] calldata hops)
        external onlyOwner returns (uint256 profit)
    {
        _checkRoute(mp.collateralToken, mp.loanToken, hops);
        uint256 baseline = IERC20H(mp.loanToken).balanceOf(address(this));
        (uint256 seized, uint256 repaid) = _morphoLiquidate(j, mp, hops, baseline);
        uint256 bal = IERC20H(mp.loanToken).balanceOf(address(this));
        if (bal < baseline + j.minProfit) revert InsufficientRepay(bal > baseline ? bal - baseline : 0, j.minProfit);
        profit = bal - baseline;
        emit LiquidationExecuted(j.borrower, mp.collateralToken, mp.loanToken, repaid, seized, 0, profit);
    }

    function _morphoLiquidate(MorphoJob calldata j, IMorphoL.MarketParams calldata mp, Hop[] calldata hops, uint256 baseline)
        internal returns (uint256 seized, uint256 repaid)
    {
        uint256 collBefore = mp.collateralToken == mp.loanToken ? baseline : IERC20H(mp.collateralToken).balanceOf(address(this));
        bytes memory data = abi.encode(mp.collateralToken, mp.loanToken, collBefore, hops);
        _morpho = j.morpho;
        (seized, repaid) = IMorphoL(j.morpho).liquidate(mp, j.borrower, j.seizedAssets, j.repaidShares, data);
        _morpho = address(0);
    }

    /// @notice Absorb a Comet borrower (optional) and buy collateral from reserves with
    /// flash-borrowed base. Owner-only. Returns realised profit in base units.
    /// @param baseAmount Base to borrow — an upper bound; only what the reserves
    ///        can fill is spent, the rest goes straight back to the lender
    function liquidateComet(uint8 source, address lender, CometJob calldata j, uint256 baseAmount, Hop[] calldata hops)
        external onlyOwner returns (uint256 profit)
    {
        address base = ICometL(j.comet).baseToken();
        _checkRoute(j.asset, base, hops);
        _flash(source, lender, base, baseAmount, abi.encode(JOB_COMET, abi.encode(j, hops)));
        profit = _takeProfit();
    }

    /// @param cTokenBorrowed   cToken of the borrowed asset (its liquidateBorrow is called)
    /// @param cTokenCollateral cToken seized
    /// @param collateral       the seized cToken's ERC20 underlying (redeem target, route start)
    /// @param repayUnderlying  the borrowed ERC20 underlying (flash asset, route end)
    /// @param borrower         position owner
    /// @param repayAmount      underlying to repay (<= closeFactor x borrow)
    /// @param minProfit        floor, in repayUnderlying units
    struct Cv2Job {
        address cTokenBorrowed;
        address cTokenCollateral;
        address collateral;
        address repayUnderlying;
        address borrower;
        uint256 repayAmount;
        uint256 minProfit;
    }

    /// @notice Liquidate a Compound V2 (or fork) position. Owner-only. Flash-borrows
    /// the repay underlying, seizes the collateral cToken, redeems it to its
    /// underlying, swaps that back to the repay asset. Returns profit in repay units.
    function liquidateCompoundV2(uint8 source, address lender, Cv2Job calldata j, Hop[] calldata hops)
        external onlyOwner returns (uint256 profit)
    {
        _checkRoute(j.collateral, j.repayUnderlying, hops);
        _flash(source, lender, j.repayUnderlying, j.repayAmount, abi.encode(JOB_CV2, abi.encode(j, hops)));
        profit = _takeProfit();
    }

    /// @param evc              the Ethereum Vault Connector
    /// @param liability        the controller (borrowed) vault; liquidate() is called on it
    /// @param collateralVault  the seized EVK vault (its shares come to us)
    /// @param collateral       that vault's ERC20 underlying (redeem target, route start)
    /// @param repayUnderlying  the liability vault's ERC20 underlying (route end, profit asset)
    /// @param violator         the unhealthy account
    /// @param repayAssets      debt to assume and clear (<= checkLiquidation maxRepay)
    /// @param minProfit        floor, in repayUnderlying units
    struct EulerJob {
        address evc;
        address liability;
        address collateralVault;
        address collateral;
        address repayUnderlying;
        address violator;
        uint256 repayAssets;
        uint256 minProfit;
    }

    /// @notice Liquidate a Euler V2 position. Owner-only. No flash loan: inside one
    /// EVC batch (checks deferred) we assume the violator's debt, take the seized
    /// vault shares, redeem them, swap to the repay asset and clear the debt.
    function liquidateEuler(EulerJob calldata j, Hop[] calldata hops) external onlyOwner returns (uint256 profit) {
        _checkRoute(j.collateral, j.repayUnderlying, hops);
        uint256 baseline = IERC20H(j.repayUnderlying).balanceOf(address(this));
        IEVCL(j.evc).enableCollateral(address(this), j.collateralVault);
        IEVCL(j.evc).enableController(address(this), j.liability);
        _evc = j.evc;
        IEVCL.BatchItem[] memory items = new IEVCL.BatchItem[](2);
        items[0] = IEVCL.BatchItem(j.liability, address(this), 0,
            abi.encodeWithSelector(IEVaultL.liquidate.selector, j.violator, j.collateralVault, j.repayAssets, uint256(0)));
        items[1] = IEVCL.BatchItem(address(this), address(this), 0,
            abi.encodeWithSelector(this.onEulerLiquidate.selector, j, hops));
        IEVCL(j.evc).batch(items);
        _evc = address(0);
        uint256 bal = IERC20H(j.repayUnderlying).balanceOf(address(this));
        if (bal < baseline + j.minProfit) revert InsufficientRepay(bal > baseline ? bal - baseline : 0, j.minProfit);
        profit = bal - baseline;
        emit LiquidationExecuted(j.violator, j.collateral, j.repayUnderlying, j.repayAssets, 0, 0, profit);
    }

    /// @notice EVC batch callback (second item of liquidateEuler). Do not call directly.
    /// Runs with checks deferred: redeem the seized shares, swap, repay the debt.
    function onEulerLiquidate(EulerJob calldata j, Hop[] calldata hops) external {
        address evc = _evc;
        if (evc == address(0) || msg.sender != evc) revert NotPool();
        uint256 shares = IERC20H(j.collateralVault).balanceOf(address(this));
        if (shares == 0) revert NothingSeized();
        uint256 collBefore = j.collateral == j.repayUnderlying ? 0 : IERC20H(j.collateral).balanceOf(address(this));
        IEVaultL(j.collateralVault).redeem(shares, address(this), address(this));
        if (j.collateral != j.repayUnderlying) {
            uint256 seized = IERC20H(j.collateral).balanceOf(address(this)) - collBefore;
            if (seized == 0) revert NothingSeized();
            _runHops(hops, seized);
        }
        IERC20H(j.repayUnderlying).approve(j.liability, j.repayAssets);
        IEVaultL(j.liability).repay(type(uint256).max, address(this));
        IERC20H(j.repayUnderlying).approve(j.liability, 0);
        IEVaultL(j.liability).disableController();
    }

    function _checkRoute(address collateral, address debt, Hop[] calldata hops) internal view {
        if (collateral == debt) {
            if (hops.length != 0) revert RouteMismatch();
        } else {
            if (hops.length == 0) revert EmptyHops();
            if (hops[0].tokenIn != collateral || hops[hops.length - 1].recipient != address(this)) revert RouteMismatch();
        }
    }

    function _flash(uint8 source, address lender, address asset, uint256 amount, bytes memory params) internal {
        if (lender == address(0)) revert NoLender();
        _lender = lender;
        if (source == SOURCE_AAVE_V3) {
            IAavePoolL(lender).flashLoanSimple(address(this), asset, amount, params, 0);
        } else if (source == SOURCE_BALANCER_V2) {
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0] = asset;
            amounts[0] = amount;
            IBalancerVaultL(lender).flashLoan(address(this), tokens, amounts, params);
        } else if (source == SOURCE_MORPHO) {
            IMorphoL(lender).flashLoan(asset, amount, abi.encode(asset, params));
        } else {
            revert BadSource(source);
        }
        _lender = address(0);
    }

    function _takeProfit() internal returns (uint256 profit) {
        profit = _profit;
        _profit = 0;
    }

    function _claimLender() internal returns (address lender) {
        lender = _lender;
        if (lender == address(0) || msg.sender != lender) revert NotPool();
        _lender = address(0);
    }

    // ---- flash callbacks --------------------------------------------------------

    /// @notice Aave V3 flash loan callback. Do not call directly.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external returns (bool)
    {
        address lender = _claimLender();
        if (initiator != address(this)) revert UntrustedInitiator();
        _run(asset, amount, premium, params);
        IERC20H(asset).approve(lender, amount + premium);
        return true;
    }

    /// @notice Balancer V2 flash loan callback. Do not call directly.
    function receiveFlashLoan(address[] calldata tokens, uint256[] calldata amounts, uint256[] calldata feeAmounts, bytes calldata userData)
        external
    {
        address lender = _claimLender();
        if (tokens.length != 1) revert AssetMismatch();
        _run(tokens[0], amounts[0], feeAmounts[0], userData);
        IERC20H(tokens[0]).transfer(lender, amounts[0] + feeAmounts[0]);
    }

    /// @notice Morpho Blue flash loan callback. Do not call directly.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        address lender = _claimLender();
        (address asset, bytes memory params) = abi.decode(data, (address, bytes));
        _run(asset, assets, 0, params);
        IERC20H(asset).approve(lender, assets);
    }

    /// @notice Morpho Blue liquidation callback. Do not call directly.
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        address morpho = _morpho;
        if (morpho == address(0) || msg.sender != morpho) revert NotPool();
        _morpho = address(0);
        (address collateral, address loan, uint256 collBefore, Hop[] memory hops) =
            abi.decode(data, (address, address, uint256, Hop[]));
        if (collateral != loan) {
            uint256 seized = IERC20H(collateral).balanceOf(address(this)) - collBefore;
            if (seized == 0) revert NothingSeized();
            _runHops(hops, seized);
        }
        IERC20H(loan).approve(morpho, repaidAssets);
    }

    // ---- jobs run inside a flash loan ---------------------------------------------

    function _run(address asset, uint256 amount, uint256 fee, bytes memory params) internal {
        (uint8 job, bytes memory payload) = abi.decode(params, (uint8, bytes));
        // Everything beyond the loan was here before (unswept profit) and is not ours to count.
        uint256 baseline = IERC20H(asset).balanceOf(address(this)) - amount;
        if (job == JOB_AAVE) {
            (Liquidation memory l, Hop[] memory hops) = abi.decode(payload, (Liquidation, Hop[]));
            if (asset != l.debt) revert AssetMismatch();
            (uint256 repaid, uint256 seized) = _liquidateAave(l, amount, baseline);
            if (l.collateral != l.debt) _runHops(hops, seized);
            uint256 profit = _settle(asset, amount + fee, baseline, l.minProfit);
            emit LiquidationExecuted(l.user, l.collateral, l.debt, repaid, seized, fee, profit);
        } else if (job == JOB_COMET) {
            (CometJob memory j, Hop[] memory hops) = abi.decode(payload, (CometJob, Hop[]));
            (uint256 spent, uint256 bought) = _buyComet(j, asset, amount);
            _runHops(hops, bought);
            uint256 profit = _settle(asset, amount + fee, baseline, j.minProfit);
            emit LiquidationExecuted(j.borrower, j.asset, asset, spent, bought, fee, profit);
        } else if (job == JOB_CV2) {
            (Cv2Job memory j, Hop[] memory hops) = abi.decode(payload, (Cv2Job, Hop[]));
            if (asset != j.repayUnderlying) revert AssetMismatch();
            uint256 seized = _liquidateCv2(j);
            _runHops(hops, seized);
            uint256 profit = _settle(asset, amount + fee, baseline, j.minProfit);
            emit LiquidationExecuted(j.borrower, j.collateral, asset, j.repayAmount, seized, fee, profit);
        } else {
            (FluidJob memory j, Hop[] memory hops) = abi.decode(payload, (FluidJob, Hop[]));
            if (asset != j.repayUnderlying) revert AssetMismatch();
            uint256 seized = _liquidateFluid(j, asset);
            if (j.collateral != asset) _runHops(hops, seized);
            uint256 profit = _settle(asset, amount + fee, baseline, j.minProfit);
            emit LiquidationExecuted(j.vault, j.collateral, asset, j.debtAmt, seized, fee, profit);
        }
    }

    /// Repay `debtAmt` into the Fluid vault, receive collateral. Returns the collateral seized.
    function _liquidateFluid(FluidJob memory j, address asset) internal returns (uint256 seized) {
        uint256 before = j.collateral == asset ? 0 : IERC20H(j.collateral).balanceOf(address(this));
        IERC20H(asset).approve(j.vault, j.debtAmt);
        IFluidVaultL(j.vault).liquidate(j.debtAmt, j.colPerUnitDebt, address(this), j.absorb);
        IERC20H(asset).approve(j.vault, 0);
        if (j.collateral == asset) return 0;
        seized = IERC20H(j.collateral).balanceOf(address(this)) - before;
        if (seized == 0) revert NothingSeized();
    }

    /// @param vault           the Fluid vault
    /// @param collateral      collateral token received (route start)
    /// @param repayUnderlying debt token repaid (flash asset, route end)
    /// @param debtAmt         debt to repay
    /// @param colPerUnitDebt  min collateral per unit debt (1e18) — slippage guard
    /// @param absorb          Fluid "with absorb" mode, as the resolver advises
    /// @param minProfit       floor, in repayUnderlying units
    struct FluidJob {
        address vault;
        address collateral;
        address repayUnderlying;
        uint256 debtAmt;
        uint256 colPerUnitDebt;
        bool absorb;
        uint256 minProfit;
    }

    /// @notice Liquidate on a Fluid vault with flash-borrowed debt. Owner-only.
    function liquidateFluid(uint8 source, address lender, FluidJob calldata j, Hop[] calldata hops)
        external onlyOwner returns (uint256 profit)
    {
        _checkRoute(j.collateral, j.repayUnderlying, hops);
        _flash(source, lender, j.repayUnderlying, j.debtAmt, abi.encode(JOB_FLUID, abi.encode(j, hops)));
        profit = _takeProfit();
    }

    /// liquidateBorrow, then redeem every seized cToken to its underlying. Returns
    /// the collateral underlying received (the swap input).
    function _liquidateCv2(Cv2Job memory j) internal returns (uint256 seizedUnderlying) {
        IERC20H(j.repayUnderlying).approve(j.cTokenBorrowed, j.repayAmount);
        if (ICErc20L(j.cTokenBorrowed).liquidateBorrow(j.borrower, j.repayAmount, j.cTokenCollateral) != 0) revert NothingSeized();
        IERC20H(j.repayUnderlying).approve(j.cTokenBorrowed, 0);
        uint256 cBal = IERC20H(j.cTokenCollateral).balanceOf(address(this));
        if (cBal == 0) revert NothingSeized();
        uint256 before = IERC20H(j.collateral).balanceOf(address(this));
        if (ICErc20L(j.cTokenCollateral).redeem(cBal) != 0) revert NothingSeized();
        seizedUnderlying = IERC20H(j.collateral).balanceOf(address(this)) - before;
        if (seizedUnderlying == 0) revert NothingSeized();
    }

    /// liquidationCall with `amount` on offer. Returns what Aave actually took
    /// and the collateral it sent us.
    function _liquidateAave(Liquidation memory l, uint256 amount, uint256 baseline) internal returns (uint256 repaid, uint256 seized) {
        bool same = l.collateral == l.debt;
        uint256 collBefore = same ? 0 : IERC20H(l.collateral).balanceOf(address(this));

        IERC20H(l.debt).approve(l.pool, amount);
        IAavePoolL(l.pool).liquidationCall(l.collateral, l.debt, l.user, amount, false);
        // Aave pulls with transferFrom, which spends allowance: what is left is what it did not take.
        repaid = amount - IERC20H(l.debt).allowance(address(this), l.pool);
        IERC20H(l.debt).approve(l.pool, 0);

        seized = same
            // Balance now = baseline + (amount - repaid) + seized.
            ? IERC20H(l.debt).balanceOf(address(this)) - baseline - (amount - repaid)
            : IERC20H(l.collateral).balanceOf(address(this)) - collBefore;
        if (seized == 0) revert NothingSeized();
    }

    /// Absorb (best effort), then buy as much of `j.asset` as reserves hold, up to `amount` of base.
    function _buyComet(CometJob memory j, address base, uint256 amount) internal returns (uint256 spend, uint256 bought) {
        if (j.borrower != address(0)) {
            address[] memory accts = new address[](1);
            accts[0] = j.borrower;
            // Someone else absorbing first is fine: the collateral is in reserves either way.
            try ICometL(j.comet).absorb(address(this), accts) {} catch {}
        }
        uint256 avail = ICometL(j.comet).getCollateralReserves(j.asset);
        // quoteCollateral is linear in baseAmount: scale the loan down to what reserves can fill.
        uint256 q = ICometL(j.comet).quoteCollateral(j.asset, amount);
        spend = q > avail ? amount * avail / q : amount;
        if (spend == 0) revert NothingSeized();
        uint256 before = IERC20H(j.asset).balanceOf(address(this));
        IERC20H(base).approve(j.comet, spend);
        ICometL(j.comet).buyCollateral(j.asset, 0, spend, address(this));
        IERC20H(base).approve(j.comet, 0);
        bought = IERC20H(j.asset).balanceOf(address(this)) - before;
        if (bought == 0) revert NothingSeized();
    }

    /// Enforce owed + minProfit against the real closing balance; record the profit.
    function _settle(address asset, uint256 owed, uint256 baseline, uint256 minProfit) internal returns (uint256 profit) {
        uint256 bal = IERC20H(asset).balanceOf(address(this)) - baseline;
        if (bal < owed + minProfit) revert InsufficientRepay(bal, owed + minProfit);
        profit = bal - owed;
        _profit = profit;
    }

    /// @notice Sweep residual balance (profit, or anything stuck) to owner.
    function sweep(address token) external onlyOwner {
        uint256 bal = IERC20H(token).balanceOf(address(this));
        if (bal > 0) IERC20H(token).transfer(owner, bal);
    }
}
