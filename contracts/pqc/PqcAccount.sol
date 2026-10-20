// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/* solhint-disable avoid-low-level-calls */
/* solhint-disable no-inline-assembly */
/* solhint-disable reason-string */

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "../core/BaseAccount.sol";
import "../core/Helpers.sol";
import "../accounts/callback/TokenCallbackHandler.sol";
import "./IMlDsa65Verifier.sol";

/**
 * ERC-4337 account whose UserOperations are authorized by an ML-DSA-65
 * (FIPS 204) signature instead of an ECDSA one -- see IMlDsa65Verifier.sol
 * for the exact scheme and its current experimental/unaudited status.
 *
 * There is no raw-EOA "owner" shortcut here (unlike SimpleAccount): the
 * only key material is the ML-DSA-65 keypair, and the only way to
 * authorize anything -- execute, upgrade, withdraw deposit -- is a
 * UserOperation that validates through the EntryPoint, because that is
 * the only path that runs _validateSignature.
 */
contract PqcAccount is BaseAccount, TokenCallbackHandler, UUPSUpgradeable, Initializable {
    IMlDsa65Verifier public immutable verifier;
    IEntryPoint private immutable _entryPoint;

    /// Packed SSTORE2 key-pointer blob from verifier.setKey(), not the raw public key.
    bytes public pqcPublicKeyBlob;

    event PqcAccountInitialized(IEntryPoint indexed entryPoint, IMlDsa65Verifier indexed verifier);

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}

    constructor(IEntryPoint anEntryPoint, IMlDsa65Verifier aVerifier) {
        _entryPoint = anEntryPoint;
        verifier = aVerifier;
        _disableInitializers();
    }

    /// @inheritdoc BaseAccount
    function entryPoint() public view virtual override returns (IEntryPoint) {
        return _entryPoint;
    }

    /**
     * @param pubkey Raw serialized ML-DSA-65 public key (FIPS 204 encoding).
     *               Stored on-chain via verifier.setKey(); this contract
     *               only ever holds the resulting pointer blob, never the
     *               full ~2.6KB key, to keep this account's own storage cheap.
     */
    function initialize(bytes calldata pubkey) public virtual initializer {
        pqcPublicKeyBlob = verifier.setKey(pubkey);
        emit PqcAccountInitialized(entryPoint(), verifier);
    }

    /// implement template method of BaseAccount
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        virtual
        override
        returns (uint256 validationData)
    {
        bytes4 magicValue = verifier.verify(pqcPublicKeyBlob, userOpHash, userOp.signature);
        if (magicValue != IMlDsa65Verifier.verify.selector) {
            return SIG_VALIDATION_FAILED;
        }
        return SIG_VALIDATION_SUCCESS;
    }

    /**
     * check current account deposit in the entryPoint
     */
    function getDeposit() public virtual view returns (uint256) {
        return entryPoint().balanceOf(address(this));
    }

    /**
     * deposit more funds for this account in the entryPoint
     */
    function addDeposit() public payable {
        entryPoint().depositTo{value: msg.value}(address(this));
    }

    /**
     * withdraw value from the account's deposit.
     * Only reachable via a validated UserOperation calling execute(address(this), 0, ...)
     * -- see _requireForExecute / BaseAccount's default (EntryPoint-only).
     */
    function withdrawDepositTo(address payable withdrawAddress, uint256 amount) public virtual {
        require(msg.sender == address(entryPoint()) || msg.sender == address(this));
        entryPoint().withdrawTo(withdrawAddress, amount);
    }

    function _authorizeUpgrade(address newImplementation) internal view override {
        (newImplementation);
        require(msg.sender == address(this), "PqcAccount: upgrade must go through a validated UserOperation");
    }
}
