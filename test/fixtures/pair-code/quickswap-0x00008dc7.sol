// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

/// @title            Decompiled Contract
/// @author           Jonathan Becker <jonathan@jbecker.dev>
/// @custom:version   heimdall-rs v0.9.2
///
/// @notice           This contract was decompiled using the heimdall-rs decompiler.
///                     It was generated directly by tracing the EVM opcodes from this contract.
///                     As a result, it may not compile or even be valid solidity code.
///                     Despite this, it should be obvious what each function does. Overall
///                     logic should have been preserved throughout decompiling.
///
/// @custom:github    You can find the open-source decompiler here:
///                       https://heimdall.rs

contract DecompiledContract {
    uint256 public constant unresolved_313ce567 = 18;
    string public constant unresolved_95d89b41 = "UNI-V2";
    uint256 public constant unresolved_30adf81f = 49955707469362902507454157297736832118868343942642399513960811609542965143241;
    string public constant unresolved_06fdde03 = "Uniswap V2";
    uint256 public constant unresolved_ba9a7a56 = 1000;
    
    address public unresolved_d21220a7;
    address public unresolved_c45a0155;
    address public unresolved_0dfe1681;
    uint256 public unresolved_5909c0d5;
    mapping(bytes32 => bytes32) storage_map_i;
    uint256 public unresolved_18160ddd;
    uint256 public unresolved_7464fc3d;
    mapping(bytes32 => bytes32) storage_map_a;
    uint256 public unresolved_3644e515;
    bytes public unresolved_0902f1ac;
    uint256 public unresolved_5a3d5493;
    bytes32 store_j;
    
    event Event_8c5be1e5();
    event Event_1c411e9a();
    event Event_ddf252ad();
    
    /// @custom:selector    0x095ea7b3
    /// @custom:signature   Unresolved_095ea7b3(address arg0, uint256 arg1) public payable returns (bool)
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    /// @param              arg1 ["uint256", "bytes32", "int256"]
    function Unresolved_095ea7b3(address arg0, uint256 arg1) public payable returns (bool) {
        var_a = address(arg0);
        storage_map_a[var_a] = arg1;
        emit Event_8c5be1e5(address(msg.sender), address(arg0), arg1);
        return 0x01;
    }
    
    /// @custom:selector    0x485cc955
    /// @custom:signature   Unresolved_485cc955(address arg0, address arg1) public payable
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    /// @param              arg1 ["address", "uint160", "bytes20", "int160"]
    function Unresolved_485cc955(address arg0, address arg1) public payable {
        require(msg.sender == (address(unresolved_c45a0155)), "UniswapV2: FORBIDDEN");
        unresolved_0dfe1681 = (uint96(unresolved_0dfe1681)) | (address(arg0));
        unresolved_d21220a7 = (uint96(unresolved_d21220a7)) | (address(arg1));
    }
    
    /// @custom:selector    0xa9059cbb
    /// @custom:signature   Unresolved_a9059cbb(address arg0, uint256 arg1) public payable returns (bool)
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    /// @param              arg1 ["uint256", "bytes32", "int256"]
    function Unresolved_a9059cbb(address arg0, uint256 arg1) public payable returns (bool) {
        address var_a = address(msg.sender);
        require(!((storage_map_a[var_a] - arg1) > storage_map_a[var_a]), "ds-math-sub-underflow");
        var_a = address(msg.sender);
        storage_map_a[var_a] = storage_map_a[var_a] - arg1;
        var_a = address(arg0);
        require(!((storage_map_a[var_a] + arg1) < storage_map_a[var_a]), "ds-math-add-overflow");
        var_a = address(arg0);
        storage_map_a[var_a] = storage_map_a[var_a] + arg1;
        emit Event_ddf252ad(address(msg.sender), address(arg0), arg1);
        return 0x01;
    }
    
    /// @custom:selector    0x23b872dd
    /// @custom:signature   Unresolved_23b872dd(address arg0, address arg1, uint256 arg2) public payable returns (bool)
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    /// @param              arg1 ["address", "uint160", "bytes20", "int160"]
    /// @param              arg2 ["uint256", "bytes32", "int256"]
    function Unresolved_23b872dd(address arg0, address arg1, uint256 arg2) public payable returns (bool) {
        var_a = msg.sender;
        require(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff == storage_map_a[var_a], "ds-math-sub-underflow");
        var_a = address(arg0);
        require(!((storage_map_a[var_a] - arg2) > storage_map_a[var_a]), "ds-math-sub-underflow");
        var_a = address(arg0);
        storage_map_a[var_a] = storage_map_a[var_a] - arg2;
        var_a = address(arg1);
        require(!((storage_map_a[var_a] + arg2) < storage_map_a[var_a]), "ds-math-add-overflow");
        var_a = address(arg1);
        storage_map_a[var_a] = storage_map_a[var_a] + arg2;
        emit Event_ddf252ad(address(arg0), address(arg1), arg2);
        return 0x01;
    }
    
    /// @custom:selector    0x70a08231
    /// @custom:signature   Unresolved_70a08231(address arg0) public view returns (uint256)
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    function Unresolved_70a08231(address arg0) public view returns (uint256) {
        address var_b = address(arg0);
        return storage_map_i[var_b];
    }
    
    /// @custom:selector    0x7ecebe00
    /// @custom:signature   Unresolved_7ecebe00(address arg0) public view returns (uint256)
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    function Unresolved_7ecebe00(address arg0) public view returns (uint256) {
        address var_b = address(arg0);
        return storage_map_i[var_b];
    }
    
    /// @custom:selector    0x022c0d9f
    /// @custom:signature   Unresolved_022c0d9f(uint256 arg0, uint256 arg1, address arg2, uint256 arg3) public payable
    /// @param              arg0 ["uint256", "bytes32", "int256"]
    /// @param              arg1 ["uint256", "bytes32", "int256"]
    /// @param              arg2 ["address", "uint160", "bytes20", "int160"]
    /// @param              arg3 ["uint256", "bytes32", "int256"]
    function Unresolved_022c0d9f(uint256 arg0, uint256 arg1, address arg2, uint256 arg3) public payable {
        require(!arg3 > 0x0100000000);
        require(0x01 == store_j, "UniswapV2: TRANSFER_FAILED");
        store_j = 0;
        require(arg0, "UniswapV2: TRANSFER_FAILED");
        require(arg0, "UniswapV2: TRANSFER_FAILED");
        require(!(arg0 < (uint112(unresolved_0902f1ac))), "UniswapV2: TRANSFER_FAILED");
        require(arg1 < (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)), "UniswapV2: TRANSFER_FAILED");
        require(address(unresolved_0dfe1681) == (address(arg2)), "UniswapV2: TRANSFER_FAILED");
        require(!(address(arg2) == (address(unresolved_d21220a7))), "UniswapV2: TRANSFER_FAILED");
        require(!arg0, "UniswapV2: TRANSFER_FAILED");
        uint256 var_a = 0x40 + var_a;
        var_a = var_a + 0x64;
        require(var_a.length < 0x20, "UniswapV2: TRANSFER_FAILED");
        (bool success, bytes memory ret0) = address(unresolved_0dfe1681).{ value: store_j ether }Unresolved_00000000(var_j); // call
        require(ret0.length == 0, "UniswapV2: TRANSFER_FAILED");
        require(!arg1);
        require(!arg3);
        address var_j = address(msg.sender);
        require(address(arg2).code.length);
        (bool success, bytes memory ret0) = address(arg2).{ value: store_j ether }Unresolved_10d1e85c(var_j); // call
        var_j = address(this);
        require(address(unresolved_0dfe1681).code.length);
        (bool success, bytes memory ret0) = address(unresolved_0dfe1681).Unresolved_70a08231(var_j); // staticcall
        require(!ret0.length < 0x20);
        var_j = address(this);
        require(address(unresolved_d21220a7).code.length);
        (bool success, bytes memory ret0) = address(unresolved_d21220a7).Unresolved_70a08231(var_j); // staticcall
        require(!(ret0.length < 0x20), "ds-math-sub-underflow");
        require(var_a.length > (uint112(unresolved_0902f1ac) - arg0), "ds-math-sub-underflow");
        require(var_a.length > (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000) - arg1), "ds-math-sub-underflow");
        require(0 > 0, "ds-math-sub-underflow");
        require(0 > 0, "ds-math-sub-underflow");
        require(!0x03, "ds-math-sub-underflow");
        require(!0x03, "ds-math-sub-underflow");
        require(!0x03e8, "ds-math-sub-underflow");
        require(!0x03e8, "ds-math-sub-underflow");
        require(!(0 > 0), "ds-math-sub-underflow");
        require(0x03e8, "ds-math-mul-overflow");
        require(0 > 0, "UniswapV2: INSUFFICIENT_INPUT_AMOUNT");
        require(0 > 0, "UniswapV2: INSUFFICIENT_INPUT_AMOUNT");
        require((var_a.length - (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000) - arg1)) > 0, "UniswapV2: INSUFFICIENT_INPUT_AMOUNT");
        require(!var_r);
        require(!var_r < 0x20);
        var_a = var_a + (uint248(ret0.length + 0x3f));
        require(!var_a.length, "UniswapV2: TRANSFER_FAILED");
        require(!var_a.length, "UniswapV2: TRANSFER_FAILED");
    }
    
    /// @custom:selector    0xfff6cae9
    /// @custom:signature   Unresolved_fff6cae9() public payable
    function Unresolved_fff6cae9() public payable {
        require(0x01 == store_j);
        store_j = 0;
        address var_b = address(this);
        require(address(unresolved_0dfe1681).code.length);
        (bool success, bytes memory ret0) = address(unresolved_0dfe1681).Unresolved_70a08231(var_b); // staticcall
        require(!ret0.length < 0x20);
        var_b = address(this);
        require(address(unresolved_d21220a7).code.length);
        (bool success, bytes memory ret0) = address(unresolved_d21220a7).Unresolved_70a08231(var_b); // staticcall
        if (!ret0.length < 0x20) {
            require(!(ret0.length < 0x20), "UniswapV2: OVERFLOW");
            require(var_c.length > 0xffffffffffffffffffffffffffff, "UniswapV2: OVERFLOW");
            require(!(var_c.length > 0xffffffffffffffffffffffffffff), "UniswapV2: OVERFLOW");
            require(!(uint32(block.timestamp - (unresolved_0902f1ac / 0x0100000000000000000000000000000000000000000000000000000000))), "UniswapV2: OVERFLOW");
            require(!(uint32(block.timestamp - (unresolved_0902f1ac / 0x0100000000000000000000000000000000000000000000000000000000))), "UniswapV2: OVERFLOW");
            unresolved_0902f1ac = (uint32(block.timestamp) * 0x0100000000000000000000000000000000000000000000000000000000) | (uint224((0x010000000000000000000000000000 * (uint112(var_c.length))) | (address(uint112(var_c.length) | (address(unresolved_0902f1ac))))));
            emit Event_1c411e9a(uint112((uint32(uint32(block.timestamp)) * 0x0100000000000000000000000000000000000000000000000000000000) | (uint224((0x010000000000000000000000000000 * (var_c.length)) | (address(var_c.length | (address(unresolved_0902f1ac))))))), uint112((uint32(uint32(block.timestamp)) * 0x0100000000000000000000000000000000000000000000000000000000) | (uint224((0x010000000000000000000000000000 * (var_c.length)) | (address(var_c.length | (address(unresolved_0902f1ac)))))) / 0x010000000000000000000000000000));
            store_j = 0x01;
            require(!(uint32(block.timestamp - (unresolved_0902f1ac / 0x0100000000000000000000000000000000000000000000000000000000))), "UniswapV2: OVERFLOW");
            require(uint112(unresolved_0902f1ac), "UniswapV2: OVERFLOW");
            unresolved_0902f1ac = (uint32(block.timestamp) * 0x0100000000000000000000000000000000000000000000000000000000) | (uint224((0x010000000000000000000000000000 * (uint112(var_c.length))) | (address(uint112(var_c.length) | (address(unresolved_0902f1ac))))));
            emit Event_1c411e9a(uint112((uint32(uint32(block.timestamp)) * 0x0100000000000000000000000000000000000000000000000000000000) | (uint224((0x010000000000000000000000000000 * (var_c.length)) | (address(var_c.length | (address(unresolved_0902f1ac))))))), uint112((uint32(uint32(block.timestamp)) * 0x0100000000000000000000000000000000000000000000000000000000) | (uint224((0x010000000000000000000000000000 * (var_c.length)) | (address(var_c.length | (address(unresolved_0902f1ac)))))) / 0x010000000000000000000000000000));
            store_j = 0x01;
            require(!(uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)), "UniswapV2: OVERFLOW");
        }
    }
    
    /// @custom:selector    0x89afcb44
    /// @custom:signature   Unresolved_89afcb44(address arg0) public payable
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    function Unresolved_89afcb44(address arg0) public payable {
        require(0x01 == store_j);
        store_j = 0;
        address var_b = address(this);
        require(address(unresolved_0dfe1681).code.length);
        (bool success, bytes memory ret0) = address(unresolved_0dfe1681).Unresolved_70a08231(var_b); // staticcall
        require(!ret0.length < 0x20);
        var_b = address(this);
        require(address(unresolved_d21220a7).code.length);
        (bool success, bytes memory ret0) = address(unresolved_d21220a7).Unresolved_70a08231(var_b); // staticcall
        require(!ret0.length < 0x20);
        require(address(unresolved_c45a0155 / 0x01).code.length);
        (bool success, bytes memory ret0) = address(unresolved_c45a0155 / 0x01).Unresolved_017e7e58(var_b); // staticcall
        require(!(ret0.length < 0x20), "ds-math-mul-overflow");
        require(!(address(var_e.length)), "ds-math-mul-overflow");
        require(!unresolved_7464fc3d, "ds-math-mul-overflow");
        require(!(uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)), "ds-math-mul-overflow");
        require(uint112(unresolved_0902f1ac / 0x010000000000000000000000000000), "ds-math-mul-overflow");
        require(uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) == (uint112(unresolved_0902f1ac)), "ds-math-mul-overflow");
        require(!(uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) > 0x03), "ds-math-sub-underflow");
        require(!(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) < (uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)))), "ds-math-sub-underflow");
        require((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01, "ds-math-sub-underflow");
        require(0x02, "ds-math-sub-underflow");
        require(!((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) + ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) / 0x02) < ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01)), "ds-math-sub-underflow");
        require(!(unresolved_7464fc3d > 0x03), "ds-math-sub-underflow");
        require(!(((unresolved_7464fc3d / 0x02) + 0x01) < unresolved_7464fc3d), "ds-math-sub-underflow");
        require((unresolved_7464fc3d / 0x02) + 0x01, "ds-math-sub-underflow");
        require(0x02, "ds-math-sub-underflow");
        require(!(((unresolved_7464fc3d / ((unresolved_7464fc3d / 0x02) + 0x01)) + ((unresolved_7464fc3d / 0x02) + 0x01) / 0x02) < ((unresolved_7464fc3d / 0x02) + 0x01)), "ds-math-sub-underflow");
        require(!(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) > ((unresolved_7464fc3d / 0x02) + 0x01)), "ds-math-sub-underflow");
        require(!(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01) > ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01)), "ds-math-sub-underflow");
        require(!(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01)), "ds-math-mul-overflow");
        require(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01), "ds-math-mul-overflow");
        require((unresolved_18160ddd * (((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01))) / (((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01)) == unresolved_18160ddd, "ds-math-mul-overflow");
        require(!0x05, "ds-math-add-overflow");
        require(!0x05, "ds-math-add-overflow");
        require(!((0 + ((unresolved_7464fc3d / 0x02) + 0x01)) < 0), "ds-math-add-overflow");
        require(0 + ((unresolved_7464fc3d / 0x02) + 0x01), "ds-math-add-overflow");
        require(!((unresolved_18160ddd * (((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01))) / (0 + ((unresolved_7464fc3d / 0x02) + 0x01))), "ds-math-add-overflow");
        require(!((unresolved_18160ddd + ((unresolved_18160ddd * (((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01))) / (0 + ((unresolved_7464fc3d / 0x02) + 0x01)))) < unresolved_18160ddd), "ds-math-add-overflow");
        require(0x05, "ds-math-mul-overflow");
        require(((((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) * 0x05) / 0x05) == ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01), "ds-math-mul-overflow");
        if ((unresolved_7464fc3d / ((unresolved_7464fc3d / 0x02) + 0x01)) + ((unresolved_7464fc3d / 0x02) + 0x01) / 0x02) {
            if (0x02) {
                if (!((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) > unresolved_7464fc3d) {
                }
                if (!unresolved_7464fc3d) {
                }
                require((unresolved_7464fc3d / ((unresolved_7464fc3d / 0x02) + 0x01)) + ((unresolved_7464fc3d / 0x02) + 0x01) / 0x02);
                require(0x02);
            }
            require(!unresolved_7464fc3d > 0x03);
        }
    }
    
    /// @custom:selector    0xd505accf
    /// @custom:signature   Unresolved_d505accf(address arg0, address arg1, uint256 arg2, uint256 arg3, bool arg4, uint256 arg5, uint256 arg6) public payable
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    /// @param              arg1 ["address", "uint160", "bytes20", "int160"]
    /// @param              arg2 ["uint256", "bytes32", "int256"]
    /// @param              arg3 ["uint256", "bytes32", "int256"]
    /// @param              arg4 ["bool", "uint8", "bytes1", "int8"]
    /// @param              arg5 ["uint256", "bytes32", "int256"]
    /// @param              arg6 ["uint256", "bytes32", "int256"]
    function Unresolved_d505accf(address arg0, address arg1, uint256 arg2, uint256 arg3, bool arg4, uint256 arg5, uint256 arg6) public payable {
        require(!arg3 < block.timestamp);
        address var_a = address(arg0);
        var_b = 0x04;
        storage_map_a[var_a] = storage_map_a[var_a] + 0x01;
        uint256 var_j = var_j + 0xe0;
        require(var_b);
        require(!(address(var_v)), "UniswapV2: INVALID_SIGNATURE");
        require(address(var_v) == (address(arg0)), "UniswapV2: INVALID_SIGNATURE");
        var_a = address(arg1);
        storage_map_a[var_a] = arg2;
        emit Event_8c5be1e5(address(arg0), address(arg1), arg2);
        require(!(!address(var_v)), "UniswapV2: INVALID_SIGNATURE");
        var_a = address(arg1);
        storage_map_a[var_a] = arg2;
        emit Event_8c5be1e5(address(arg0), address(arg1), arg2);
    }
    
    /// @custom:selector    0xdd62ed3e
    /// @custom:signature   Unresolved_dd62ed3e(address arg0, address arg1) public view returns (uint256)
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    /// @param              arg1 ["address", "uint160", "bytes20", "int160"]
    function Unresolved_dd62ed3e(address arg0, address arg1) public view returns (uint256) {
        address var_b = address(arg0);
        var_b = address(arg1);
        return storage_map_i[var_b];
    }
    
    /// @custom:selector    0x6a627842
    /// @custom:signature   Unresolved_6a627842(address arg0) public payable
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    function Unresolved_6a627842(address arg0) public payable {
        require(0x01 == store_j);
        store_j = 0;
        address var_b = address(this);
        require(address(unresolved_0dfe1681).code.length);
        (bool success, bytes memory ret0) = address(unresolved_0dfe1681).Unresolved_70a08231(var_b); // staticcall
        require(!ret0.length < 0x20);
        var_b = address(this);
        require(address(unresolved_d21220a7).code.length);
        (bool success, bytes memory ret0) = address(unresolved_d21220a7).Unresolved_70a08231(var_b); // staticcall
        require(!(ret0.length < 0x20), "ds-math-sub-underflow");
        require(!((var_c.length - (uint112(unresolved_0902f1ac))) > var_c.length), "ds-math-sub-underflow");
        require(!((var_c.length - (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000))) > var_c.length), "ds-math-sub-underflow");
        var_b = 0x20;
        require(address(unresolved_c45a0155 / 0x01).code.length);
        (bool success, bytes memory ret0) = address(unresolved_c45a0155 / 0x01).Unresolved_017e7e58(var_b); // staticcall
        require(!(ret0.length < 0x20), "ds-math-mul-overflow");
        require(!(address(var_c.length)), "ds-math-mul-overflow");
        require(!unresolved_7464fc3d, "ds-math-mul-overflow");
        require(!(uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)), "ds-math-mul-overflow");
        require(uint112(unresolved_0902f1ac / 0x010000000000000000000000000000), "ds-math-mul-overflow");
        require(uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) == (uint112(unresolved_0902f1ac)), "ds-math-mul-overflow");
        require(!(uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) > 0x03), "ds-math-sub-underflow");
        require(!(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) < (uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)))), "ds-math-sub-underflow");
        require((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01, "ds-math-sub-underflow");
        require(0x02, "ds-math-sub-underflow");
        require(!((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) + ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) / 0x02) < ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01)), "ds-math-sub-underflow");
        require(!(unresolved_7464fc3d > 0x03), "ds-math-sub-underflow");
        require(!(((unresolved_7464fc3d / 0x02) + 0x01) < unresolved_7464fc3d), "ds-math-sub-underflow");
        require((unresolved_7464fc3d / 0x02) + 0x01, "ds-math-sub-underflow");
        require(0x02, "ds-math-sub-underflow");
        require(!(((unresolved_7464fc3d / ((unresolved_7464fc3d / 0x02) + 0x01)) + ((unresolved_7464fc3d / 0x02) + 0x01) / 0x02) < ((unresolved_7464fc3d / 0x02) + 0x01)), "ds-math-sub-underflow");
        require(!(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) > ((unresolved_7464fc3d / 0x02) + 0x01)), "ds-math-sub-underflow");
        require(!(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01) > ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01)), "ds-math-sub-underflow");
        require(!(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01)), "ds-math-mul-overflow");
        require(((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01), "ds-math-mul-overflow");
        require((unresolved_18160ddd * (((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01))) / (((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01)) == unresolved_18160ddd, "ds-math-mul-overflow");
        require(!0x05, "ds-math-add-overflow");
        require(!0x05, "ds-math-add-overflow");
        require(!((0 + ((unresolved_7464fc3d / 0x02) + 0x01)) < 0), "ds-math-add-overflow");
        require(0 + ((unresolved_7464fc3d / 0x02) + 0x01), "ds-math-add-overflow");
        require(!((unresolved_18160ddd * (((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01))) / (0 + ((unresolved_7464fc3d / 0x02) + 0x01))), "ds-math-add-overflow");
        require(!((unresolved_18160ddd + ((unresolved_18160ddd * (((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) - ((unresolved_7464fc3d / 0x02) + 0x01))) / (0 + ((unresolved_7464fc3d / 0x02) + 0x01)))) < unresolved_18160ddd), "ds-math-add-overflow");
        if (unresolved_18160ddd) {
        }
        require(0x05, "ds-math-mul-overflow");
        require(((((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) * 0x05) / 0x05) == ((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01), "ds-math-mul-overflow");
        if ((unresolved_7464fc3d / ((unresolved_7464fc3d / 0x02) + 0x01)) + ((unresolved_7464fc3d / 0x02) + 0x01) / 0x02) {
            if (0x02) {
                if (!((uint112(unresolved_0902f1ac) * (uint112(unresolved_0902f1ac / 0x010000000000000000000000000000)) / 0x02) + 0x01) > unresolved_7464fc3d) {
                }
                if (!unresolved_7464fc3d) {
                }
                require((unresolved_7464fc3d / ((unresolved_7464fc3d / 0x02) + 0x01)) + ((unresolved_7464fc3d / 0x02) + 0x01) / 0x02);
                require(0x02);
            }
            require(!unresolved_7464fc3d > 0x03);
        }
    }
    
    /// @custom:selector    0xbc25cf77
    /// @custom:signature   Unresolved_bc25cf77(address arg0) public payable
    /// @param              arg0 ["address", "uint160", "bytes20", "int160"]
    function Unresolved_bc25cf77(address arg0) public payable {
        require(0x01 == store_j);
        store_j = 0;
        address var_b = address(this);
        require(address(unresolved_0dfe1681).code.length);
        (bool success, bytes memory ret0) = address(unresolved_0dfe1681).Unresolved_70a08231(var_b); // staticcall
        require(!(ret0.length < 0x20), "ds-math-sub-underflow");
        require(!((var_c.length - (uint112(unresolved_0902f1ac))) > var_c.length), "ds-math-sub-underflow");
        uint256 var_c = 0x40 + var_c;
        var_c = var_c + 0x64;
        require(var_c.length < 0x20, "UniswapV2: TRANSFER_FAILED");
        (bool success, bytes memory ret0) = address(unresolved_0dfe1681).{ value: store_j ether }Unresolved_00000000(var_m); // call
        require(ret0.length == 0, "UniswapV2: TRANSFER_FAILED");
        require(address(unresolved_d21220a7).code.length);
        require(!var_p);
        require(!var_p < 0x20);
        var_c = var_c + (uint248(ret0.length + 0x3f));
        require(address(unresolved_d21220a7).code.length);
        require(!var_c.length, "UniswapV2: TRANSFER_FAILED");
        require(!var_c.length, "UniswapV2: TRANSFER_FAILED");
    }
}