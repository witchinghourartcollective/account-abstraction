import { Wallet } from 'ethers'
import { ethers } from 'hardhat'
import { expect } from 'chai'
import { arrayify, hexConcat, parseEther } from 'ethers/lib/utils'
import { ecsign, toRpcSig } from 'ethereumjs-util'

import {
  EntryPoint,
  SampleAggregator,
  SampleAggregator__factory
} from '../typechain'
import {
  createAccountOwner,
  createAddress,
  deployEntryPoint
} from './testutils'
import { getUserOpHash, packUserOp, fillUserOpDefaults } from './UserOp'

/**
 * Sign a 32-byte hash with the eth_sign prefix using an ethers Wallet.
 * Produces a 65-byte (r, s, v) signature.
 */
function ethSignHash (hash: string, wallet: Wallet): string {
  const prefixedHash = ethers.utils.hashMessage(arrayify(hash))
  const sig = ecsign(
    Buffer.from(arrayify(prefixedHash)),
    Buffer.from(arrayify(wallet.privateKey))
  )
  return toRpcSig(sig.v, sig.r, sig.s)
}

describe('SampleAggregator', function () {
  const ethersSigner = ethers.provider.getSigner()
  let entryPoint: EntryPoint
  let aggregator: SampleAggregator

  before(async function () {
    entryPoint = await deployEntryPoint()
    aggregator = await new SampleAggregator__factory(ethersSigner).deploy(entryPoint.address)
  })

  describe('aggregateSignatures', () => {
    it('should concatenate individual 65-byte signatures', async () => {
      const owner1 = createAccountOwner()
      const owner2 = createAccountOwner()
      const sig1 = '0x' + '11'.repeat(65)
      const sig2 = '0x' + '22'.repeat(65)

      const op1 = fillUserOpDefaults({ sender: owner1.address, signature: sig1 })
      const op2 = fillUserOpDefaults({ sender: owner2.address, signature: sig2 })

      const aggSig = await aggregator.aggregateSignatures([packUserOp(op1), packUserOp(op2)])
      expect(aggSig).to.equal(hexConcat([sig1, sig2]))
    })

    it('should reject if any individual signature is not 65 bytes', async () => {
      const owner1 = createAccountOwner()
      const badSig = '0x' + 'aa'.repeat(64) // 64 bytes — wrong length
      const op = fillUserOpDefaults({ sender: owner1.address, signature: badSig })
      await expect(
        aggregator.aggregateSignatures([packUserOp(op)])
      ).to.be.revertedWith('InvalidSignatureLength')
    })
  })

  describe('validateUserOpSignature', () => {
    it('should return the userOp signature unchanged', async () => {
      const owner = createAccountOwner()
      const sig = '0x' + 'ab'.repeat(65)
      const op = fillUserOpDefaults({ sender: owner.address, signature: sig })
      const result = await aggregator.validateUserOpSignature(packUserOp(op))
      expect(result).to.equal(sig)
    })
  })

  describe('validateSignatures', () => {
    it('should accept valid aggregated signature', async () => {
      const chainId = await ethers.provider.getNetwork().then(n => n.chainId)
      const owner1 = createAccountOwner()
      const owner2 = createAccountOwner()

      const op1 = fillUserOpDefaults({ sender: owner1.address, nonce: 0 })
      const op2 = fillUserOpDefaults({ sender: owner2.address, nonce: 0 })

      // Compute each EIP-712 userOpHash and sign with eth_sign prefix.
      // The SampleAggregator wraps the userOpHash with toEthSignedMessageHash before recovery.
      const hash1 = getUserOpHash(op1, entryPoint.address, chainId)
      const hash2 = getUserOpHash(op2, entryPoint.address, chainId)

      const sig1 = ethSignHash(hash1, owner1)
      const sig2 = ethSignHash(hash2, owner2)

      const aggSig = hexConcat([sig1, sig2])
      const packed1 = packUserOp({ ...op1, signature: sig1 })
      const packed2 = packUserOp({ ...op2, signature: sig2 })

      // Should not revert
      await aggregator.validateSignatures([packed1, packed2], aggSig)
    })

    it('should reject mismatched aggregated signature', async () => {
      const chainId = await ethers.provider.getNetwork().then(n => n.chainId)
      const owner1 = createAccountOwner()
      const owner2 = createAccountOwner()
      const impostor = createAccountOwner()

      const op1 = fillUserOpDefaults({ sender: owner1.address, nonce: 0 })
      const op2 = fillUserOpDefaults({ sender: owner2.address, nonce: 0 })

      const hash1 = getUserOpHash(op1, entryPoint.address, chainId)
      const hash2 = getUserOpHash(op2, entryPoint.address, chainId)

      // Sign op2 with an impostor — recovery will yield wrong address
      const sig1 = ethSignHash(hash1, owner1)
      const badSig2 = ethSignHash(hash2, impostor)

      const aggSig = hexConcat([sig1, badSig2])
      const packed1 = packUserOp({ ...op1, signature: sig1 })
      const packed2 = packUserOp({ ...op2, signature: badSig2 })

      await expect(
        aggregator.validateSignatures([packed1, packed2], aggSig)
      ).to.be.revertedWith('SignerMismatch')
    })

    it('should reject if aggregated signature byte-length does not match userOps count * 65', async () => {
      const owner1 = createAccountOwner()
      const op1 = fillUserOpDefaults({ sender: owner1.address, nonce: 0 })
      // Provide 130 bytes for 1 op (should be 65)
      const wrongSig = '0x' + 'aa'.repeat(65 * 2)
      await expect(
        aggregator.validateSignatures([packUserOp(op1)], wrongSig)
      ).to.be.revertedWith('SignatureCountMismatch')
    })
  })

  describe('entryPoint reference', () => {
    it('should return the correct entryPoint', async () => {
      expect(await aggregator.entryPoint()).to.equal(entryPoint.address)
    })
  })

  describe('stake management', () => {
    it('owner should be able to add stake', async () => {
      await aggregator.addStake(86400, { value: parseEther('0.1') })
      const info = await entryPoint.getDepositInfo(aggregator.address)
      expect(info.staked).to.equal(true)
    })
  })
})

