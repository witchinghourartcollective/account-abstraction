import { Wallet } from 'ethers'
import { ethers } from 'hardhat'
import { expect } from 'chai'
import { hexConcat, hexZeroPad, hexlify, parseEther } from 'ethers/lib/utils'

import {
  EntryPoint,
  SimpleAccount,
  VerifyingPaymaster,
  VerifyingPaymaster__factory
} from '../typechain'
import {
  createAccount,
  createAccountOwner,
  createAddress,
  decodeRevertReason,
  deployEntryPoint
} from './testutils'
import { fillAndSign, packUserOp } from './UserOp'

describe('VerifyingPaymaster', function () {
  const ethersSigner = ethers.provider.getSigner()
  let entryPoint: EntryPoint
  let paymaster: VerifyingPaymaster
  let accountOwner: Wallet
  let account: SimpleAccount
  let verifyingSignerWallet: Wallet
  const beneficiary = createAddress()

  /**
   * Build paymasterData with validUntil and validAfter encoded as 6 bytes each.
   */
  function buildPaymasterData (validUntil: number, validAfter: number): string {
    return hexConcat([
      hexZeroPad(hexlify(validUntil), 6),
      hexZeroPad(hexlify(validAfter), 6)
    ])
  }

  /**
   * Sign the raw paymaster hash using eth_sign (wallet.signMessage adds the prefix).
   */
  async function signPaymasterHash (rawHash: string, signer: Wallet): Promise<string> {
    return signer.signMessage(ethers.utils.arrayify(rawHash))
  }

  before(async function () {
    entryPoint = await deployEntryPoint()
    verifyingSignerWallet = createAccountOwner()
    accountOwner = createAccountOwner()

    paymaster = await new VerifyingPaymaster__factory(ethersSigner).deploy(
      entryPoint.address,
      verifyingSignerWallet.address
    )
    await entryPoint.depositTo(paymaster.address, { value: parseEther('1') })
    const { proxy } = await createAccount(ethersSigner, accountOwner.address, entryPoint.address)
    account = proxy
  })

  it('should be deployed with correct verifyingSigner', async () => {
    expect(await paymaster.verifyingSigner()).to.equal(verifyingSignerWallet.address)
  })

  it('owner should be able to update verifyingSigner', async () => {
    const newSigner = createAddress()
    await expect(paymaster.setVerifyingSigner(newSigner))
      .to.emit(paymaster, 'VerifyingSignerUpdated')
    expect(await paymaster.verifyingSigner()).to.equal(newSigner)
    // restore original
    await paymaster.setVerifyingSigner(verifyingSignerWallet.address)
  })

  it('non-owner should not be able to update verifyingSigner', async () => {
    const otherSigner = ethers.provider.getSigner(1)
    const newSigner = createAddress()
    await expect(
      paymaster.connect(otherSigner).setVerifyingSigner(newSigner)
    ).to.be.reverted
  })

  it('should revert if paymasterSignature is missing', async () => {
    const validUntil = 0
    const validAfter = 0
    const paymasterData = buildPaymasterData(validUntil, validAfter)
    // No paymasterSignature appended — InvalidSignatureLength(0) expected
    const op = await fillAndSign({
      sender: account.address,
      paymaster: paymaster.address,
      paymasterData
    }, accountOwner, entryPoint)

    const revertReason = await entryPoint.callStatic
      .handleOps([packUserOp(op)], beneficiary)
      .catch(decodeRevertReason)
    expect(revertReason).to.match(/AA33|InvalidSignatureLength/)
  })

  it('should revert if signed by wrong signer', async () => {
    const validUntil = 0
    const validAfter = 0
    const paymasterData = buildPaymasterData(validUntil, validAfter)

    const op = await fillAndSign({
      sender: account.address,
      paymaster: paymaster.address,
      paymasterData,
      paymasterSignature: '0x' + '00'.repeat(65)
    }, accountOwner, entryPoint)

    const wrongSigner = createAccountOwner()
    const rawHash = await paymaster.getHash(packUserOp(op), validUntil, validAfter)
    const wrongSig = await signPaymasterHash(rawHash, wrongSigner)
    op.paymasterSignature = wrongSig

    const revertReason = await entryPoint.callStatic
      .handleOps([packUserOp(op)], beneficiary)
      .catch(decodeRevertReason)
    expect(revertReason).to.match(/AA34/)
  })

  it('should succeed with correct verifyingSigner signature', async () => {
    const validUntil = 0
    const validAfter = 0
    const paymasterData = buildPaymasterData(validUntil, validAfter)

    const op = await fillAndSign({
      sender: account.address,
      paymaster: paymaster.address,
      paymasterData,
      paymasterSignature: '0x' + '00'.repeat(65)
    }, accountOwner, entryPoint)

    const rawHash = await paymaster.getHash(packUserOp(op), validUntil, validAfter)
    const validSig = await signPaymasterHash(rawHash, verifyingSignerWallet)
    op.paymasterSignature = validSig

    const result = await entryPoint.handleOps([packUserOp(op)], beneficiary)
      .then(async r => r.wait())
    const events = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), result.blockHash)
    expect(events[0].args.success).to.equal(true)
  })

  it('getHash should differ when validUntil changes', async () => {
    const paymasterData = buildPaymasterData(0, 0)
    const op = await fillAndSign({
      sender: account.address,
      paymaster: paymaster.address,
      paymasterData,
      paymasterSignature: '0x' + '00'.repeat(65)
    }, accountOwner, entryPoint)
    const packedOp = packUserOp(op)
    const hash1 = await paymaster.getHash(packedOp, 0, 0)
    const hash2 = await paymaster.getHash(packedOp, 9999, 0)
    expect(hash1).to.not.equal(hash2)
  })
})

