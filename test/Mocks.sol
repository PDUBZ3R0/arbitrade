// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20M {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Plain ERC20, optionally with a transfer tax. taxBps is taken from every
/// transfer and burned, which is what a reflection/tax token does to the amount
/// the recipient actually receives.
contract MockToken {
    string public name;
    uint8 public decimals = 18;
    uint256 public totalSupply;
    uint16 public taxBps;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, uint16 _taxBps) {
        name = _name;
        taxBps = _taxBps;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function _move(address from, address to, uint256 amt) internal {
        require(balanceOf[from] >= amt, "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= amt;
        uint256 tax = (amt * taxBps) / 10_000;
        balanceOf[to] += amt - tax;
        totalSupply -= tax;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        _move(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(allowance[from][msg.sender] >= amt, "allowance");
        allowance[from][msg.sender] -= amt;
        _move(from, to, amt);
        return true;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }
}

/// Constant-product pair with the REAL UniswapV2 K check, so a wrong output
/// request reverts here exactly as it would on-chain. `feeBps` makes the K
/// check use this pair's actual fee rather than a hardcoded 0.3%.
contract MockPair {
    /// Real V2 pairs emit this at the end of swap/mint/burn — the live feed's
    /// entire input. Same signature, so the topic hash matches production.
    event Sync(uint112 reserve0, uint112 reserve1);

    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint16 public feeBps;

    constructor(address _t0, address _t1, uint16 _feeBps) {
        (token0, token1) = _t0 < _t1 ? (_t0, _t1) : (_t1, _t0);
        feeBps = _feeBps;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    /// Seed reserves from whatever has been transferred in.
    function sync() external {
        reserve0 = uint112(IERC20M(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20M(token1).balanceOf(address(this)));
        emit Sync(reserve0, reserve1);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT");
        (uint112 r0, uint112 r1) = (reserve0, reserve1);
        require(amount0Out < r0 && amount1Out < r1, "UniswapV2: INSUFFICIENT_LIQUIDITY");

        if (amount0Out > 0) IERC20M(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20M(token1).transfer(to, amount1Out);

        uint256 bal0 = IERC20M(token0).balanceOf(address(this));
        uint256 bal1 = IERC20M(token1).balanceOf(address(this));
        uint256 in0 = bal0 > r0 - amount0Out ? bal0 - (r0 - amount0Out) : 0;
        uint256 in1 = bal1 > r1 - amount1Out ? bal1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "UniswapV2: INSUFFICIENT_INPUT_AMOUNT");

        // The K check, with this pair's fee. 10_000 scale.
        uint256 adj0 = bal0 * 10_000 - in0 * uint256(feeBps);
        uint256 adj1 = bal1 * 10_000 - in1 * uint256(feeBps);
        require(adj0 * adj1 >= uint256(r0) * uint256(r1) * (10_000 ** 2), "UniswapV2: K");

        reserve0 = uint112(bal0);
        reserve1 = uint112(bal1);
        emit Sync(reserve0, reserve1);
    }

    /// Simulate someone else trading this pair between our quote and our
    /// execution — the reserve-drift case the old executor could not survive.
    function drift(address tokenIn, uint256 amountIn) external {
        IERC20M(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        bool zero = tokenIn == token0;
        (uint112 rIn, uint112 rOut) = zero ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 inAfterFee = amountIn * (10_000 - uint256(feeBps));
        uint256 out = (inAfterFee * rOut) / (uint256(rIn) * 10_000 + inAfterFee);
        IERC20M(zero ? token1 : token0).transfer(msg.sender, out);
        reserve0 = uint112(IERC20M(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20M(token1).balanceOf(address(this)));
        emit Sync(reserve0, reserve1);
    }
}

interface IFlashReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external returns (bool);
}

/// Mock Aave V3 pool: lends, calls back, then pulls repayment via allowance.
contract MockAavePool {
    uint256 public premiumBps;

    constructor(uint256 _premiumBps) { premiumBps = _premiumBps; }

    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        uint256 premium = (amount * premiumBps) / 10_000;
        IERC20M(asset).transfer(receiver, amount);
        require(IFlashReceiver(receiver).executeOperation(asset, amount, premium, receiver, params), "cb");
        require(IERC20M(asset).transferFrom(receiver, address(this), amount + premium), "repay");
    }
}

interface IBalancerRecipient {
    function receiveFlashLoan(address[] calldata tokens, uint256[] calldata amounts, uint256[] calldata fees, bytes calldata data) external;
}

/// Mock Balancer V2 vault: lends, calls back, then checks it was paid back by
/// transfer (balance-based, like the real vault). feeBps models a non-zero
/// protocol flash fee.
contract MockBalancerVault {
    uint256 public feeBps;
    constructor(uint256 _feeBps) { feeBps = _feeBps; }

    function flashLoan(address recipient, address[] calldata tokens, uint256[] calldata amounts, bytes calldata data) external {
        uint256[] memory fees = new uint256[](tokens.length);
        uint256[] memory before = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            before[i] = IERC20M(tokens[i]).balanceOf(address(this));
            fees[i] = (amounts[i] * feeBps) / 10_000;
            IERC20M(tokens[i]).transfer(recipient, amounts[i]);
        }
        IBalancerRecipient(recipient).receiveFlashLoan(tokens, amounts, fees, data);
        for (uint256 i = 0; i < tokens.length; i++) {
            require(IERC20M(tokens[i]).balanceOf(address(this)) >= before[i] + fees[i], "BAL#602");
        }
    }
}

interface IMorphoCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

/// Mock Morpho Blue: free flash loan, repaid by transferFrom after the callback.
contract MockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        IERC20M(token).transfer(msg.sender, assets);
        IMorphoCallback(msg.sender).onMorphoFlashLoan(assets, data);
        require(IERC20M(token).transferFrom(msg.sender, address(this), assets), "repay");
    }
}

// -----------------------------------------------------------------------------
// Velodrome V2 / Aerodrome shapes. The parts the bot depends on are copied
// from velodrome-finance/contracts (Pool.sol, PoolFactory.sol): the
// PoolCreated event with `stable` INDEXED, getFee(pool, stable) in bps with
// the 420 zero-fee sentinel, getReserves() returning uint256s, the fee taken
// off the input and moved OUT of the pool before the K check, and
// Sync(uint256,uint256).
// -----------------------------------------------------------------------------

interface IVeloFactoryM { function getFee(address pool, bool stable) external view returns (uint256); }
interface IPoolCalleeM { function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external; }

contract MockVeloPool {
    event Sync(uint256 reserve0, uint256 reserve1);
    address public immutable factory;
    address public token0;
    address public token1;
    bool public immutable stable;
    uint256 public reserve0;
    uint256 public reserve1;

    constructor(address _t0, address _t1, bool _stable) {
        factory = msg.sender; token0 = _t0; token1 = _t1; stable = _stable;
    }
    function getReserves() external view returns (uint256, uint256, uint256) { return (reserve0, reserve1, block.timestamp); }
    function sync() external {
        reserve0 = IERC20M(token0).balanceOf(address(this));
        reserve1 = IERC20M(token1).balanceOf(address(this));
        emit Sync(reserve0, reserve1);
    }
    function _k(uint256 x, uint256 y) internal view returns (uint256) {
        if (stable) {   // x^3*y + y^3*x, all tokens here are 18-decimal
            uint256 a = (x * y) / 1e18;
            uint256 b = (x * x) / 1e18 + (y * y) / 1e18;
            return (a * b) / 1e18;
        }
        return x * y;
    }
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(amount0Out > 0 || amount1Out > 0, "IOA");
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        require(amount0Out < r0 && amount1Out < r1, "IL");
        if (amount0Out > 0) IERC20M(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20M(token1).transfer(to, amount1Out);
        if (data.length > 0) IPoolCalleeM(to).hook(msg.sender, amount0Out, amount1Out, data);
        uint256 b0 = IERC20M(token0).balanceOf(address(this));
        uint256 b1 = IERC20M(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "IIA");
        // Fees leave the pool (Velodrome sends them to PoolFees).
        uint256 fee = IVeloFactoryM(factory).getFee(address(this), stable);
        if (in0 > 0) IERC20M(token0).transfer(factory, (in0 * fee) / 10_000);
        if (in1 > 0) IERC20M(token1).transfer(factory, (in1 * fee) / 10_000);
        b0 = IERC20M(token0).balanceOf(address(this));
        b1 = IERC20M(token1).balanceOf(address(this));
        require(_k(b0, b1) >= _k(r0, r1), "K");
        reserve0 = b0; reserve1 = b1;
        emit Sync(b0, b1);
    }
}

contract MockVeloFactory {
    event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256);
    uint256 public constant ZERO_FEE_INDICATOR = 420;
    uint256 public stableFee = 5;     // 0.05%
    uint256 public volatileFee = 30;  // 0.30%
    mapping(address => uint256) public customFee;
    address[] public allPools;

    function createPool(address tokenA, address tokenB, bool stable) external returns (address pool) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pool = address(new MockVeloPool(t0, t1, stable));
        allPools.push(pool);
        emit PoolCreated(t0, t1, stable, pool, allPools.length);
    }
    function setCustomFee(address pool, uint256 fee) external { customFee[pool] = fee; }
    function getFee(address pool, bool _stable) public view returns (uint256) {
        uint256 fee = customFee[pool];
        return fee == ZERO_FEE_INDICATOR ? 0 : fee != 0 ? fee : _stable ? stableFee : volatileFee;
    }
}
