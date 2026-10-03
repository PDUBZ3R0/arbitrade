// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPool {
    function mint(address, int24, int24, uint128, bytes calldata) external returns (uint256, uint256);
    function burn(int24, int24, uint128) external returns (uint256, uint256);
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

contract Tok {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
}

contract Harness {
    function pay(address pool, int256 a0, int256 a1) internal {
        if (a0 > 0) Tok(IPool(pool).token0()).mint(pool, uint256(a0));
        if (a1 > 0) Tok(IPool(pool).token1()).mint(pool, uint256(a1));
    }
    function uniswapV3MintCallback(uint256 a0, uint256 a1, bytes calldata) external {
        pay(msg.sender, int256(a0), int256(a1));
    }
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        pay(msg.sender, a0, a1);
    }
    function mint(address pool, int24 lo, int24 hi, uint128 amt) external {
        IPool(pool).mint(address(this), lo, hi, amt, "");
    }
    function burn(address pool, int24 lo, int24 hi, uint128 amt) external {
        IPool(pool).burn(lo, hi, amt);
    }
    function swap(address pool, bool z, int256 amt, uint160 lim) external {
        IPool(pool).swap(address(this), z, amt, lim, "");
    }
    // Intended for eth_call: swap, then report the post-state.
    function swapReport(address pool, bool z, int256 amt, uint160 lim)
        external returns (int256 a0, int256 a1, uint160 sp, int24 tick, uint128 liq)
    {
        (a0, a1) = IPool(pool).swap(address(this), z, amt, lim, "");
        (sp, tick,,,,,) = IPool(pool).slot0();
        liq = IPool(pool).liquidity();
    }
}
