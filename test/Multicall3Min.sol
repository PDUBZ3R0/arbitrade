// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal Multicall3, only `aggregate3`, matching the real contract's ABI
/// bit-for-bit so source/util/multicall.ts cannot tell the difference.
///
/// The real Multicall3 is predeployed at 0xcA11bde05977b3631167028862bE2a173976CA11
/// on essentially every chain, so build-hops.ts hardcodes that address. A fresh
/// anvil has nothing there, and an eth_call to a codeless address SUCCEEDS
/// returning 0x — which is precisely the failure mode that produced a fake
/// "simulated clean" against a mis-configured executor address earlier in this
/// project. So the test deploys this and relocates its runtime code to the
/// canonical address with anvil_setCode; aggregate3 holds no state, so moving
/// the code is sound.
contract Multicall3Min {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) public payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            Result memory result = returnData[i];
            Call3 calldata calli = calls[i];
            (result.success, result.returnData) = calli.target.call(calli.callData);
            if (!(calli.allowFailure || result.success)) revert("Multicall3: call failed");
        }
    }
}
