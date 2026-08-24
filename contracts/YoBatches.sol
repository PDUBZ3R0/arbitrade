//SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}

struct ReserveRespose {
    address pair;
    address token0;
    uint256 reserves0;
    address token1;
    uint256 reserves1;
}

contract YoBatches {

    function getReservesByPairs(address[3][] calldata args) external view returns (ReserveRespose[] memory) {
        ReserveRespose[] memory result = new ReserveRespose[](args.length);
        for (uint i = 0; i < args.length; i++) {
            ReserveRespose memory response = ReserveRespose(args[i][0], args[i][1], wbalance(IERC20Minimal(args[i][1]),args[i][0]), args[i][2], wbalance(IERC20Minimal(args[i][2]),args[i][0]));
            result[i] = response;
        }
        return result;
    }

    // Wrapped call to get balance should catch errors where one of the tokens does not 
    // implement ERC20 balanceOf method signature (rare, but is possible);
    function wbalance(IERC20Minimal token, address pool) public view returns (uint256) {
        try this.cbalance(token, pool) returns (uint256 t) {
            return t;
        } catch (bytes memory ) {
            return 0;
        }
    }

    function cbalance(IERC20Minimal token, address pool) public view returns (uint256) {
        uint256 csize;
        assembly { csize := extcodesize(token) }
        if (csize == 0) {
            return 0;
        }
        try token.balanceOf(pool) returns(uint256 t) {
            return t;
        } catch(bytes memory ) {
            return 0;
        }
    }
}