// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// solhint-disable no-inline-assembly

import "../interfaces/PackedUserOperation.sol";
import "../core/UserOperationLib.sol";

library Eip7702Support {

    error Eip7702SenderWithoutCode(address sender);
    error Eip7702SenderNotDelegate(address sender);

    // EIP-7702 code prefix before delegate address.
    bytes3 internal constant EIP7702_PREFIX = 0xef0100;

    // EIP-7702 initCode marker, to specify this account is EIP-7702.
    bytes2 internal constant INITCODE_EIP7702_MARKER = 0x7702;

    using UserOperationLib for PackedUserOperation;

    /**
     * @notice Get the alternative 'InitCodeHash' value for the UserOp hash calculation when using EIP-7702.
     *
     * When the UserOperation's `initCode` contains the EIP-7702 marker, the hash
     * is derived from the delegate address (and optional extra data) rather than
     * the raw `initCode` bytes. This ensures the hash is chain-specific to the
     * currently active delegate contract.
     *
     * @param userOp - The UserOperation for the 'InitCodeHash' calculation.
     * @return       - The 'InitCodeHash' value to use in the UserOp hash, or 0 if
     *                 `userOp.initCode` is not an EIP-7702 initCode.
     */
    function _getEip7702InitCodeHashOverride(PackedUserOperation calldata userOp) internal view returns (bytes32) {
        bytes calldata initCode = userOp.initCode;
        if (!_isEip7702InitCode(initCode)) {
            return 0;
        }
        address delegate = _getEip7702Delegate(userOp.sender);
        if (initCode.length <= 20)
            return keccak256(abi.encodePacked(delegate));
        else
            return keccak256(abi.encodePacked(delegate, initCode[20 :]));
    }

    /**
     * @notice Check if this 'initCode' is actually an EIP-7702 authorisation.
     *         This is indicated by 'initCode' that starts with INITCODE_EIP7702_MARKER.
     *
     * @param initCode - The 'initCode' bytes to inspect.
     * @return         - `true` if the 'initCode' encodes an EIP-7702 authorisation; `false` otherwise.
     */
    function _isEip7702InitCode(bytes calldata initCode) internal pure returns (bool) {

        if (initCode.length < 2) {
            return false;
        }
        bytes20 initCodeStart;
        // non-empty calldata bytes are always zero-padded to 32-bytes, so can be safely casted to "bytes20"
        assembly ("memory-safe") {
            initCodeStart := calldataload(initCode.offset)
        }
        // make sure first 20 bytes of initCode are "0x7702" (padded with zeros)
        return initCodeStart == bytes20(INITCODE_EIP7702_MARKER);
    }

    /**
     * @notice Get the EIP-7702 delegate address from the sender's contract code.
     *         Must only be called when `_isEip7702InitCode(initCode)` returns `true`.
     *
     * Reads the first 23 bytes of the sender's deployed code.  A valid EIP-7702
     * delegation starts with the three-byte prefix `0xef0100` followed by the
     * 20-byte delegate address.
     *
     * @param sender - The account whose deployed code encodes the EIP-7702 delegation.
     * @return       - The address of the delegated implementation contract.
     */
    function _getEip7702Delegate(address sender) internal view returns (address) {

        bytes32 senderCode;

        assembly ("memory-safe") {
            extcodecopy(sender, 0, 0, 23)
            senderCode := mload(0)
        }
        // To be a valid EIP-7702 delegate, the first 3 bytes are EIP7702_PREFIX
        // followed by the delegate address
        if (bytes3(senderCode) != EIP7702_PREFIX) {
            require(sender.code.length > 0, Eip7702SenderWithoutCode(sender));
            revert Eip7702SenderNotDelegate(sender);
        }
        return address(bytes20(senderCode << 24));
    }
}
