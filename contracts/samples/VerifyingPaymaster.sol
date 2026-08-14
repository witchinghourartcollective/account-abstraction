// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/* solhint-disable avoid-low-level-calls */

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "../core/BasePaymaster.sol";
import "../core/UserOperationLib.sol";
import "../core/Helpers.sol";

/**
 * @title VerifyingPaymaster
 * @notice A sample paymaster that validates UserOperations using an off-chain signature
 *         from a designated verifier signer.
 *
 * The paymaster data layout (after the standard 52-byte paymaster header) is:
 *   - validUntil  (6 bytes): the last timestamp this sponsorship is valid
 *   - validAfter  (6 bytes): the first timestamp this sponsorship is valid
 *
 * The paymaster *signature* (appended via the standard paymaster-signature suffix) is:
 *   - ECDSA signature (65 bytes) over the hash of
 *     (sender, nonce, initCode, callData, accountGasLimits, preVerificationGas,
 *      gasFees, chainId, paymaster address, validUntil, validAfter)
 *
 * Off-chain the sponsor calls `getHash` to obtain the hash, signs it with the
 * verifier key, and places that signature in the `paymasterSignature` field
 * (appended after the paymaster data using `UserOperationLib.encodePaymasterSignature`).
 */
contract VerifyingPaymaster is BasePaymaster {

    /// @notice The account whose ECDSA signature authorises gas sponsorship.
    address public verifyingSigner;

    uint256 private constant VALID_TIMESTAMP_OFFSET = UserOperationLib.PAYMASTER_DATA_OFFSET;
    uint256 private constant SIGNATURE_OFFSET = VALID_TIMESTAMP_OFFSET + 12; // 6 + 6 timestamp bytes

    /// @notice Emitted when the verifying signer is updated.
    event VerifyingSignerUpdated(address indexed oldSigner, address indexed newSigner);

    error InvalidSignatureLength(uint256 length);
    error InvalidVerifyingSigner(address signer);

    /**
     * @param _entryPoint       - The ERC-4337 EntryPoint contract.
     * @param _verifyingSigner  - The address whose signatures authorise sponsorship.
     */
    constructor(
        IEntryPoint _entryPoint,
        address _verifyingSigner
    ) BasePaymaster(_entryPoint, msg.sender) {
        if (_verifyingSigner == address(0)) revert InvalidVerifyingSigner(_verifyingSigner);
        verifyingSigner = _verifyingSigner;
    }

    /**
     * @notice Update the verifying signer address (only owner).
     * @param newSigner - The new signer address.
     */
    function setVerifyingSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidVerifyingSigner(newSigner);
        emit VerifyingSignerUpdated(verifyingSigner, newSigner);
        verifyingSigner = newSigner;
    }

    /**
     * @notice Return the hash used to sign the UserOperation sponsorship.
     *         The hash covers: sender, nonce, initCode, callData, accountGasLimits,
     *         preVerificationGas, gasFees, chainId, this paymaster address,
     *         validUntil, and validAfter.
     *
     * @dev Returns the *raw* keccak256 hash (without any `eth_sign` prefix).
     *      Off-chain signers should use `eth_sign` (e.g. `wallet.signMessage`) on
     *      the returned bytes, which internally applies the prefix before signing.
     *
     * @param userOp     - The user operation.
     * @param validUntil - The last timestamp this sponsorship is valid (0 = indefinitely).
     * @param validAfter - The first timestamp this sponsorship is valid.
     * @return           - The raw keccak256 hash to be signed off-chain.
     */
    function getHash(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter
    ) public view returns (bytes32) {
        return keccak256(abi.encode(
            userOp.sender,
            userOp.nonce,
            calldataKeccak(userOp.initCode),
            calldataKeccak(userOp.callData),
            userOp.accountGasLimits,
            userOp.preVerificationGas,
            userOp.gasFees,
            block.chainid,
            address(this),
            validUntil,
            validAfter
        ));
    }

    /**
     * @inheritdoc BasePaymaster
     * @dev Decodes validUntil/validAfter from paymasterData and verifies the
     *      off-chain ECDSA signature from `verifyingSigner`.
     *      Returns SIG_VALIDATION_FAILED packed into validationData if the
     *      recovered signer does not match.
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) internal virtual override returns (bytes memory context, uint256 validationData) {
        (userOpHash, maxCost);

        bytes calldata paymasterAndData = userOp.paymasterAndData;

        uint48 validUntil = uint48(bytes6(paymasterAndData[VALID_TIMESTAMP_OFFSET : VALID_TIMESTAMP_OFFSET + 6]));
        uint48 validAfter = uint48(bytes6(paymasterAndData[VALID_TIMESTAMP_OFFSET + 6 : SIGNATURE_OFFSET]));

        bytes calldata signature = UserOperationLib.getPaymasterSignature(paymasterAndData);
        if (signature.length != 65) revert InvalidSignatureLength(signature.length);

        bytes32 hash = getHash(userOp, validUntil, validAfter);
        // Apply eth_sign prefix before recovering — the off-chain signer must use `eth_sign`.
        address recovered = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(hash), signature);

        // Pack validationData: marks SIG_VALIDATION_FAILED if wrong signer, includes time bounds.
        validationData = _packValidationData(
            recovered != verifyingSigner,
            validUntil,
            validAfter
        );
        return ("", validationData);
    }
}
