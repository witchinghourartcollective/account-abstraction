// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Wire-compatible with ZKNoxHQ/ETHDILITHIUM's `ZKNOX_dilithium65` contract
 * (branch `mldsa-65`, src/ZKNOX_dilithium65.sol) -- FIPS 204 ML-DSA-65
 * (k=6, l=5), the same parameter set used across this protocol's
 * ML-DSA-65 consensus-checkpoint layer (see hOUR-Chain's
 * packages/pqc-checkpoint and docs/SIGNATURE-CANONICALIZATION.md).
 *
 * NOT an abstraction over "any PQC scheme" -- it is this one scheme at
 * this one parameter set, matching a specific on-chain verifier's ABI.
 * That verifier is explicitly marked experimental/unaudited by its own
 * authors ("DO NOT USE IN PRODUCTION, LOSS OF FUNDS WILL OCCUR" --
 * ZKNoxHQ/ETHDILITHIUM README, mldsa-65 branch, as of 2026-09-16). Treat
 * any deployment behind this interface accordingly.
 */
interface IMlDsa65Verifier {
    /**
     * @notice Store an expanded ML-DSA-65 public key via SSTORE2, returning
     *         the packed key-pointer blob that `verify`'s `pk` parameter
     *         expects. Call once per account at setup time.
     * @param pubkey Serialized ML-DSA-65 public key (FIPS 204 encoding).
     * @return pk Packed SSTORE2 pointer blob to pass to `verify`.
     */
    function setKey(bytes memory pubkey) external returns (bytes memory pk);

    /**
     * @notice ERC-1271-style verification entry point.
     * @param pk Packed key-pointer blob returned by a prior `setKey` call --
     *           NOT the raw public key bytes.
     * @param m Message hash (e.g. a UserOperation hash).
     * @param signature Raw ML-DSA-65 signature, exactly 3309 bytes
     *                  (48-byte cTilde || 3200-byte z || 61-byte h).
     * @return magicValue `IMlDsa65Verifier.verify.selector` on success,
     *                     `0xFFFFFFFF` on failure.
     */
    function verify(bytes calldata pk, bytes32 m, bytes calldata signature) external view returns (bytes4);
}
