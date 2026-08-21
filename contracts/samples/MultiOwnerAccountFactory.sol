// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../interfaces/ISenderCreator.sol";
import "../interfaces/IEntryPoint.sol";
import "./MultiOwnerAccount.sol";

/**
 * @title MultiOwnerAccountFactory
 * @notice Factory for deploying {MultiOwnerAccount} proxies via CREATE2.
 *
 * The factory caches a single implementation and deploys ERC-1967 proxies
 * pointing to it.  It mirrors the pattern used by {SimpleAccountFactory}.
 */
contract MultiOwnerAccountFactory {
    /// @notice The shared implementation contract used by all proxies.
    MultiOwnerAccount public immutable accountImplementation;
    /// @notice The EntryPoint's SenderCreator – only it may call {createAccount}.
    ISenderCreator public immutable senderCreator;

    error NotSenderCreator(address msgSender, address entity, address senderCreator);

    constructor(IEntryPoint _entryPoint) {
        accountImplementation = new MultiOwnerAccount(_entryPoint);
        senderCreator = _entryPoint.senderCreator();
    }

    /**
     * @notice Deploy (or return the already-deployed) account for the given
     *         owner set and salt.  Must be called by the EntryPoint's SenderCreator.
     * @param owners - The initial owner addresses.
     * @param salt   - A user-chosen salt for CREATE2 address derivation.
     * @return ret   - The proxy account (deployed or already existing).
     */
    function createAccount(address[] calldata owners, uint256 salt) public returns (MultiOwnerAccount ret) {
        require(
            msg.sender == address(senderCreator),
            NotSenderCreator(msg.sender, address(this), address(senderCreator))
        );
        address addr = getAddress(owners, salt);
        if (addr.code.length > 0) {
            return MultiOwnerAccount(payable(addr));
        }
        ret = MultiOwnerAccount(payable(new ERC1967Proxy{salt: bytes32(salt)}(
            address(accountImplementation),
            abi.encodeCall(MultiOwnerAccount.initialize, (owners))
        )));
    }

    /**
     * @notice Compute the counterfactual address of the account before deployment.
     * @param owners - The initial owner addresses.
     * @param salt   - The same salt that will be used in {createAccount}.
     * @return       - The deterministic proxy address.
     */
    function getAddress(address[] calldata owners, uint256 salt) public virtual view returns (address) {
        return Create2.computeAddress(
            bytes32(salt),
            keccak256(abi.encodePacked(
                type(ERC1967Proxy).creationCode,
                abi.encode(
                    address(accountImplementation),
                    abi.encodeCall(MultiOwnerAccount.initialize, (owners))
                )
            ))
        );
    }
}
