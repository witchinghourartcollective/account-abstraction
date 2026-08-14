// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IEntryPoint.sol";
import "../accounts/Simple7702Account.sol";

/**
 * @title Simple7702AccountHelper
 * @notice A deployment helper for the {Simple7702Account} EIP-7702 delegation flow.
 *
 * EIP-7702 accounts do not use CREATE2 factories for deployment. Instead, the user
 * signs an EIP-7702 authorisation that makes their EOA delegate all calls to the
 * `Simple7702Account` implementation already deployed on-chain.
 *
 * This helper contract:
 *   1. Holds the canonical `Simple7702Account` implementation address.
 *   2. Provides `getInitCode` to build the `initCode` bytes that a bundler places
 *      in a `UserOperation` when an EIP-7702 account is used for the first time.
 *   3. Provides `getImplementationAddress` as a single source-of-truth so UIs and
 *      SDKs can discover the canonical delegate address for this chain/entrypoint.
 *
 * @dev The contract itself does **not** deploy accounts; it is a read-only utility.
 */
contract Simple7702AccountHelper {

    /// @notice The canonical Simple7702Account implementation used as the EIP-7702 delegate.
    Simple7702Account public immutable implementation;

    /// @notice EIP-7702 initCode marker used to signal EIP-7702 delegation in a UserOperation.
    bytes2 private constant INITCODE_EIP7702_MARKER = 0x7702;

    /**
     * @param _entryPoint - The ERC-4337 EntryPoint to bind the implementation to.
     */
    constructor(IEntryPoint _entryPoint) {
        implementation = new Simple7702Account(_entryPoint);
    }

    /**
     * @notice Return the address of the canonical Simple7702Account implementation.
     * @return The implementation contract address to use as the EIP-7702 delegate.
     */
    function getImplementationAddress() external view returns (address) {
        return address(implementation);
    }

    /**
     * @notice Build the `initCode` value to embed in a UserOperation for an EIP-7702
     *         account's first use.
     *
     * The initCode encodes:
     *   - the INITCODE_EIP7702_MARKER (2 bytes)
     *   - this helper's address (20 bytes), so the EntryPoint can locate the delegate
     *
     * @dev Bundlers and SDKs should pass this as the `initCode` field in the
     *      `PackedUserOperation` when the sender's code is not yet set.
     * @return The bytes to use as `initCode` in a 7702 UserOperation.
     */
    function getInitCode() external view returns (bytes memory) {
        return abi.encodePacked(INITCODE_EIP7702_MARKER, address(this));
    }
}
