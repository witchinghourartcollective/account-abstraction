// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "../interfaces/IAggregator.sol";
import "../interfaces/IEntryPoint.sol";
import "../core/Stakeable.sol";

/**
 * @title SampleAggregator
 * @notice A reference IAggregator implementation that verifies individual ECDSA
 *         signatures and "aggregates" them by concatenation.
 *
 * This is intentionally simple: it does **not** implement BLS or any advanced
 * cryptography. Its purpose is to demonstrate the IAggregator interface so that
 * developers can understand the bundler / EntryPoint aggregation flow before
 * writing their own aggregator.
 *
 * Accounts that wish to use this aggregator should:
 *   1. Return this contract's address from `validateUserOp` (packed into the
 *      aggregator field of the validationData return value).
 *   2. Sign the userOpHash with their private key and place the individual
 *      65-byte signature in `userOp.signature`.
 *
 * The bundler:
 *   - Calls `validateUserOpSignature` per-op to obtain each normalised sig.
 *   - Calls `aggregateSignatures` to combine them into one blob.
 *   - Passes the combined blob to `handleOps` → EntryPoint calls
 *     `validateSignatures` once for the whole batch.
 */
contract SampleAggregator is IAggregator, Stakeable {

    IEntryPoint private immutable _entryPoint;

    error SignatureCountMismatch(uint256 userOpsLength, uint256 signaturesByteLength);
    error InvalidSignatureLength(uint256 index, uint256 length);
    error SignerMismatch(uint256 index, address expected, address recovered);

    constructor(IEntryPoint entryPointAddr) Ownable(msg.sender) {
        _entryPoint = entryPointAddr;
    }

    /// @inheritdoc Stakeable
    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    /**
     * @inheritdoc IAggregator
     * @notice Validate that each userOp's individual signature (embedded inside
     *         the aggregated `signature` blob) is a valid ECDSA signature over
     *         the userOpHash by the account that submitted it.
     *
     * The `signature` parameter is the concatenation of 65-byte individual
     * signatures produced by `aggregateSignatures`. Signatures are ordered
     * to match the `userOps` array.
     *
     * @param userOps   - The user operations whose signatures to verify.
     * @param signature - Concatenated 65-byte ECDSA signatures, one per userOp.
     */
    function validateSignatures(
        PackedUserOperation[] calldata userOps,
        bytes calldata signature
    ) external view override {
        uint256 count = userOps.length;
        if (signature.length != count * 65) {
            revert SignatureCountMismatch(count, signature.length);
        }

        for (uint256 i = 0; i < count; i++) {
            bytes calldata sig = signature[i * 65 : (i + 1) * 65];
            _verifyOneSig(i, userOps[i], sig);
        }
    }

    /**
     * @inheritdoc IAggregator
     * @notice Validate a single UserOperation's signature off-chain (called by
     *         the bundler during simulation).  Returns the same 65-byte signature
     *         unchanged so the bundler can include it verbatim in the aggregated
     *         blob produced by `aggregateSignatures`.
     *
     * @param userOp        - The user operation to validate.
     * @return sigForUserOp - The 65-byte signature to include in the aggregate.
     */
    function validateUserOpSignature(
        PackedUserOperation calldata userOp
    ) external view override returns (bytes memory sigForUserOp) {
        return userOp.signature;
    }

    /**
     * @inheritdoc IAggregator
     * @notice Concatenate the individual signatures from each UserOperation
     *         into a single blob for submission with `handleOps`.
     *
     * @param userOps              - The user operations.
     * @return aggregatedSignature - Concatenation of each userOp.signature (65 bytes each).
     */
    function aggregateSignatures(
        PackedUserOperation[] calldata userOps
    ) external pure override returns (bytes memory aggregatedSignature) {
        uint256 count = userOps.length;
        // Pre-allocate: each individual sig must be 65 bytes.
        aggregatedSignature = new bytes(count * 65);
        for (uint256 i = 0; i < count; i++) {
            bytes calldata sig = userOps[i].signature;
            if (sig.length != 65) revert InvalidSignatureLength(i, sig.length);
            uint256 offset = i * 65;
            assembly ("memory-safe") {
                calldatacopy(add(add(aggregatedSignature, 0x20), offset), sig.offset, 65)
            }
        }
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * @dev Verify a single userOp's signature against its sender.
     *      The signer is expected to be the account address itself (i.e. the
     *      EOA that was delegated via EIP-7702, or any account that signs with
     *      its own private key).  Accounts that use a different key management
     *      scheme should override or specialise this aggregator.
     *
     * @param index  - Position in the batch (for error reporting).
     * @param userOp - The user operation being verified.
     * @param sig    - The 65-byte individual ECDSA signature.
     */
    function _verifyOneSig(
        uint256 index,
        PackedUserOperation calldata userOp,
        bytes calldata sig
    ) internal view {
        bytes32 userOpHash = _entryPoint.getUserOpHash(userOp);
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        address recovered = ECDSA.recover(ethHash, sig);
        if (recovered != userOp.sender) {
            revert SignerMismatch(index, userOp.sender, recovered);
        }
    }
}
