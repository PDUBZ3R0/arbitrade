// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 interface
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Aave V3 pool — single-asset flash loan entrypoint
interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// @notice Standard V2-style pair interface. Covers v2, v2fee, and solidly
/// factory families from the DEX pattern registry — fee mechanics live in
/// each pair's reserves math (already accounted for off-chain by the
/// evaluator), not in the swap() call itself, so one interface fits all.
interface IUniswapV2Pair {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @title FlashArbExecutor
/// @notice Executes a triangular arb as a chain of optimistic V2-style swaps,
/// funded by an Aave V3 flash loan. Each hop sends its output straight to the
/// next pair (no intermediate custody), and the final hop returns the root
/// asset to this contract for repayment. All swap amounts are computed
/// off-chain by the evaluator (piece 5) from known reserves — this contract
/// does no pricing math, it only executes and checks solvency.
contract FlashArbExecutor {
    address public immutable owner;
    address public immutable aavePool;

    /// @param pair       V2-style pair contract for this hop
    /// @param amount0Out Precomputed off-chain; 0 if token0 is the input side
    /// @param amount1Out Precomputed off-chain; 0 if token1 is the input side
    /// @param recipient  Next pair in the chain, or address(this) on the final hop
    struct Hop {
        address pair;
        uint256 amount0Out;
        uint256 amount1Out;
        address recipient;
    }

    error NotOwner();
    error NotPool();
    error UntrustedInitiator();
    error InsufficientRepay();
    error EmptyHops();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _aavePool) {
        owner = msg.sender;
        aavePool = _aavePool;
    }

    /// @notice Kick off a flash-loan arb. Owner-only.
    /// @param asset Root token to borrow — the triangle's start/end token
    /// @param amount Amount to borrow, in asset's native units
    /// @param hops Ordered swap chain; hops[0].pair must accept `asset` as input
    function executeArb(address asset, uint256 amount, Hop[] calldata hops) external onlyOwner {
        if (hops.length == 0) revert EmptyHops();
        bytes memory params = abi.encode(hops, asset);
        IPool(aavePool).flashLoanSimple(address(this), asset, amount, params, 0);
    }

    /// @notice Aave V3 flash loan callback. Do not call directly.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != aavePool) revert NotPool();
        if (initiator != address(this)) revert UntrustedInitiator();

        (Hop[] memory hops, address rootAsset) = abi.decode(params, (Hop[], address));

        // Optimistic transfer: fund the first pair directly, V2-swap style.
        IERC20(rootAsset).transfer(hops[0].pair, amount);

        uint256 len = hops.length;
        for (uint256 i = 0; i < len; i++) {
            Hop memory h = hops[i];
            IUniswapV2Pair(h.pair).swap(h.amount0Out, h.amount1Out, h.recipient, "");
        }

        uint256 amountOwed = amount + premium;
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal < amountOwed) revert InsufficientRepay();

        IERC20(asset).approve(aavePool, amountOwed);
        return true;
    }

    /// @notice Sweep residual balance (profit, or anything stuck) to owner.
    function sweep(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(owner, bal);
    }
}
