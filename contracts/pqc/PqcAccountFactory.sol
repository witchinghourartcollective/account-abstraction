// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../interfaces/ISenderCreator.sol";
import "./PqcAccount.sol";

/**
 * Factory for PqcAccount, following the same counterfactual-address
 * pattern as SimpleAccountFactory -- see that contract's comment.
 */
contract PqcAccountFactory {
    PqcAccount public immutable accountImplementation;
    ISenderCreator public immutable senderCreator;

    error NotSenderCreator(address msgSender, address entity, address senderCreator);

    constructor(IEntryPoint _entryPoint, IMlDsa65Verifier _verifier) {
        accountImplementation = new PqcAccount(_entryPoint, _verifier);
        senderCreator = _entryPoint.senderCreator();
    }

    /**
     * create an account, and return its address.
     * returns the address even if the account is already deployed.
     * @param pubkey The pre-expanded ML-DSA-65 key blob for the new account
     *               (see PqcAccount.initialize / IMlDsa65Verifier.setKey) --
     *               NOT the raw public key.
     */
    function createAccount(bytes calldata pubkey, uint256 salt) public returns (PqcAccount ret) {
        require(msg.sender == address(senderCreator),
            NotSenderCreator(
                msg.sender,
                address(this),
                address(senderCreator)
            )
        );
        address addr = getAddress(pubkey, salt);
        uint256 codeSize = addr.code.length;
        if (codeSize > 0) {
            return PqcAccount(payable(addr));
        }
        ret = PqcAccount(payable(new ERC1967Proxy{salt : bytes32(salt)}(
                address(accountImplementation),
                abi.encodeCall(PqcAccount.initialize, (pubkey))
            )));
    }

    /**
     * calculate the counterfactual address of this account as it would be returned by createAccount()
     */
    function getAddress(bytes calldata pubkey, uint256 salt) public virtual view returns (address) {
        return Create2.computeAddress(bytes32(salt), keccak256(abi.encodePacked(
                type(ERC1967Proxy).creationCode,
                abi.encode(
                    address(accountImplementation),
                    abi.encodeCall(PqcAccount.initialize, (pubkey))
                )
            )));
    }
}
