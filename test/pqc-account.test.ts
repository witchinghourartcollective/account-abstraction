import { ethers } from 'hardhat'
import { expect } from 'chai'
import { randomBytes, hexlify } from 'ethers/lib/utils'
import { toHex } from 'hardhat/internal/util/bigint'
import { JsonRpcProvider } from '@ethersproject/providers'

import {
  EntryPoint,
  PqcAccount,
  PqcAccountFactory__factory,
  PqcAccount__factory,
  TestMlDsaVerifier,
  TestMlDsaVerifier__factory
} from '../typechain'
import { deployEntryPoint } from './testutils'
import { fillUserOpDefaults, packUserOp } from './UserOp'

const SIG_VALIDATION_SUCCESS = 0
const SIG_VALIDATION_FAILED = 1

describe('PqcAccount', function () {
  let entryPoint: EntryPoint
  let verifier: TestMlDsaVerifier
  let account: PqcAccount
  let pubkey: string
  const ethersSigner = ethers.provider.getSigner()

  before(async function () {
    entryPoint = await deployEntryPoint()
    verifier = await new TestMlDsaVerifier__factory(ethersSigner).deploy()
    pubkey = hexlify(randomBytes(1952)) // FIPS 204 ML-DSA-65 public key size

    const factory = await new PqcAccountFactory__factory(ethersSigner).deploy(entryPoint.address, verifier.address)
    const senderCreator = await entryPoint.senderCreator()
    await (ethersSigner.provider as JsonRpcProvider).send('hardhat_setBalance', [senderCreator, toHex(100e18)])
    const senderCreatorSigner = await ethers.getImpersonatedSigner(senderCreator)
    await factory.connect(senderCreatorSigner).createAccount(pubkey, 0)
    const accountAddress = await factory.getAddress(pubkey, 0)
    account = PqcAccount__factory.connect(accountAddress, ethersSigner)
  })

  it('initialize() stores the verifier-returned key blob, not the raw pubkey directly re-stored elsewhere', async () => {
    // TestMlDsaVerifier.setKey echoes the pubkey back, so this also checks
    // the wiring: PqcAccount.initialize -> verifier.setKey -> stored blob.
    expect(await account.pqcPublicKeyBlob()).to.equal(pubkey)
    expect(await account.verifier()).to.equal(verifier.address)
  })

  async function validateAs (signature: string, userOpHash: string): Promise<number> {
    const userOp = packUserOp(fillUserOpDefaults({ sender: account.address, signature }))
    await (ethersSigner.provider as JsonRpcProvider).send('hardhat_setBalance', [entryPoint.address, toHex(100e18)])
    const entryPointSigner = await ethers.getImpersonatedSigner(entryPoint.address)
    const validationData = await account.connect(entryPointSigner).callStatic.validateUserOp(userOp, userOpHash, 0)
    return validationData.toNumber()
  }

  it('accepts a signature the verifier marks as valid for this exact (pk, hash, signature)', async () => {
    const userOpHash = ethers.utils.keccak256('0x1234')
    const signature = hexlify(randomBytes(3309)) // ML-DSA-65 signature size
    await verifier.setResult(pubkey, userOpHash, signature, true)

    expect(await validateAs(signature, userOpHash)).to.equal(SIG_VALIDATION_SUCCESS)
  })

  it('rejects a signature the verifier has not marked valid', async () => {
    const userOpHash = ethers.utils.keccak256('0x5678')
    const signature = hexlify(randomBytes(3309))
    // deliberately not calling verifier.setResult(..., true)

    expect(await validateAs(signature, userOpHash)).to.equal(SIG_VALIDATION_FAILED)
  })

  it('rejects when the signature is valid for a different userOpHash (no cross-message replay)', async () => {
    const signedHash = ethers.utils.keccak256('0xaaaa')
    const otherHash = ethers.utils.keccak256('0xbbbb')
    const signature = hexlify(randomBytes(3309))
    await verifier.setResult(pubkey, signedHash, signature, true)

    expect(await validateAs(signature, otherHash)).to.equal(SIG_VALIDATION_FAILED)
  })

  it('rejects calls to validateUserOp from anyone other than the entryPoint', async () => {
    const userOp = packUserOp(fillUserOpDefaults({ sender: account.address, signature: '0x' }))
    const caller = await ethersSigner.getAddress()
    await expect(account.validateUserOp(userOp, ethers.utils.keccak256('0x01'), 0))
      .to.be.revertedWith(`NotFromEntryPoint("${caller}", "${account.address}", "${entryPoint.address}")`)
  })

  it('rejects execute() calls that did not go through a validated UserOperation', async () => {
    const caller = await ethersSigner.getAddress()
    await expect(account.execute(caller, 0, '0x'))
      .to.be.revertedWith(`NotFromEntryPoint("${caller}", "${account.address}", "${entryPoint.address}")`)
  })
})
