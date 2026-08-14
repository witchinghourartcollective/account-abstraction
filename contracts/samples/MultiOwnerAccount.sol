// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/* solhint-disable avoid-low-level-calls */
/* solhint-disable no-inline-assembly */

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "../core/BaseAccount.sol";
import "../core/Helpers.sol";
import "../accounts/callback/TokenCallbackHandler.sol";

/**
 * @title MultiOwnerAccount
 * @notice A sample ERC-4337 smart-contract account that supports multiple ECDSA owners.
 *
 * Any owner can directly call `execute` / `executeBatch`. A UserOperation is
 * considered valid when *at least one* owner's signature is recovered from the
 * userOpHash. The owner set is managed by any current owner via
 * `addOwner` / `removeOwner`.
 */
contract MultiOwnerAccount is BaseAccount, TokenCallbackHandler, UUPSUpgradeable, Initializable {

    /// @notice Mapping of owner addresses to their membership status.
    mapping(address => bool) public owners;
    /// @notice Total number of current owners.
    uint256 public ownerCount;

    IEntryPoint private immutable _entryPoint;

    /// @notice Emitted when the account is initialised with its first owner set.
    event MultiOwnerAccountInitialized(IEntryPoint indexed entryPoint, address[] indexed initialOwners);
    /// @notice Emitted when an owner is added.
    event OwnerAdded(address indexed owner);
    /// @notice Emitted when an owner is removed.
    event OwnerRemoved(address indexed owner);

    error OnlyOwner();
    error OnlyOwnerOrEntryPoint();
    error AlreadyOwner(address owner);
    error NotOwner(address owner);
    error LastOwner();
    error EmptyOwnerList();

    modifier onlyOwner() {
        if (!owners[msg.sender] && msg.sender != address(this)) revert OnlyOwner();
        _;
    }

    /// @inheritdoc BaseAccount
    function entryPoint() public view virtual override returns (IEntryPoint) {
        return _entryPoint;
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}

    constructor(IEntryPoint anEntryPoint) {
        _entryPoint = anEntryPoint;
        _disableInitializers();
    }

    /**
     * @notice Initialise the account with the initial owner set.
     * @param initialOwners - Array of addresses that become the initial owners.
     */
    function initialize(address[] calldata initialOwners) public virtual initializer {
        _initialize(initialOwners);
    }

    function _initialize(address[] calldata initialOwners) internal virtual {
        if (initialOwners.length == 0) revert EmptyOwnerList();
        for (uint256 i = 0; i < initialOwners.length; i++) {
            address owner = initialOwners[i];
            if (owners[owner]) revert AlreadyOwner(owner);
            owners[owner] = true;
        }
        ownerCount = initialOwners.length;
        emit MultiOwnerAccountInitialized(_entryPoint, initialOwners);
    }

    /**
     * @notice Add a new owner. Can only be called by an existing owner or through EntryPoint.
     * @param owner - The address to add as an owner.
     */
    function addOwner(address owner) external onlyOwner {
        if (owners[owner]) revert AlreadyOwner(owner);
        owners[owner] = true;
        ownerCount++;
        emit OwnerAdded(owner);
    }

    /**
     * @notice Remove an existing owner. Can only be called by an existing owner or through EntryPoint.
     *         At least one owner must remain after removal.
     * @param owner - The address to remove from the owner set.
     */
    function removeOwner(address owner) external onlyOwner {
        if (!owners[owner]) revert NotOwner(owner);
        if (ownerCount == 1) revert LastOwner();
        owners[owner] = false;
        ownerCount--;
        emit OwnerRemoved(owner);
    }

    /// @inheritdoc BaseAccount
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
    internal override virtual returns (uint256 validationData) {
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        address recovered = ECDSA.recover(hash, userOp.signature);
        if (!owners[recovered]) {
            return SIG_VALIDATION_FAILED;
        }
        return SIG_VALIDATION_SUCCESS;
    }

    /// @inheritdoc BaseAccount
    function _requireForExecute() internal view override virtual {
        if (msg.sender != address(entryPoint()) && !owners[msg.sender] && msg.sender != address(this)) {
            revert OnlyOwnerOrEntryPoint();
        }
    }

    /**
     * @notice Return the current deposit of this account in the EntryPoint.
     * @return The deposit balance.
     */
    function getDeposit() public virtual view returns (uint256) {
        return entryPoint().balanceOf(address(this));
    }

    /**
     * @notice Deposit more funds for this account in the EntryPoint.
     */
    function addDeposit() public payable {
        entryPoint().depositTo{value: msg.value}(address(this));
    }

    /**
     * @notice Withdraw from this account's EntryPoint deposit.
     * @param withdrawAddress - Target address to receive the withdrawn value.
     * @param amount          - Amount to withdraw.
     */
    function withdrawDepositTo(address payable withdrawAddress, uint256 amount) public virtual onlyOwner {
        entryPoint().withdrawTo(withdrawAddress, amount);
    }

    function _authorizeUpgrade(address newImplementation) internal view override {
        (newImplementation);
        if (!owners[msg.sender] && msg.sender != address(this)) revert OnlyOwner();
    }
}
