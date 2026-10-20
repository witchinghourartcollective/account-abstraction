// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../pqc/IMlDsa65Verifier.sol";

/**
 * Deterministic stand-in for the real ZKNOX_dilithium65 verifier, so
 * PqcAccount's own validation-routing logic (not the lattice crypto) can
 * be unit-tested without the real, currently-unbuildable-here (no local
 * Foundry toolchain), unaudited third-party verifier. See
 * contracts/pqc/IMlDsa65Verifier.sol for what this stands in for.
 *
 * setKey here just echoes the pubkey back as the "pk" blob (the real
 * verifier instead returns a packed SSTORE2 pointer pair) -- good enough
 * to exercise PqcAccount's control flow, not a substitute for testing
 * actual ML-DSA-65 verification correctness.
 */
contract TestMlDsaVerifier is IMlDsa65Verifier {
    mapping(bytes32 => bool) public shouldVerify;

    function setKey(bytes memory pubkey) external pure returns (bytes memory pk) {
        return pubkey;
    }

    /// Test hook: pre-program whether a given (pk, m, signature) triple verifies.
    function setResult(bytes calldata pk, bytes32 m, bytes calldata signature, bool result) external {
        shouldVerify[keccak256(abi.encode(pk, m, signature))] = result;
    }

    function verify(bytes calldata pk, bytes32 m, bytes calldata signature) external view returns (bytes4) {
        if (shouldVerify[keccak256(abi.encode(pk, m, signature))]) {
            return IMlDsa65Verifier.verify.selector;
        }
        return 0xFFFFFFFF;
    }
}
