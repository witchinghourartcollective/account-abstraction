import { Wallet } from 'ethers'
import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther } from 'ethers/lib/utils'
import { JsonRpcProvider } from '@ethersproject/providers'

import {
  EntryPoint,
  MultiOwnerAccount,
  MultiOwnerAccountFactory,
  MultiOwnerAccountFactory__factory,
  MultiOwnerAccount__factory,
  ERC1967Proxy__factory
} from '../typechain'
import {
  ONE_ETH,
  createAccountOwner,
  createAddress,
  deployEntryPoint,
  fund,
  isDeployed
} from './testutils'
import { fillAndSign, packUserOp } from './UserOp'

describe('MultiOwnerAccount', function () {
  const ethersSigner = ethers.provider.getSigner()
  let entryPoint: EntryPoint
  let owner1: Wallet
  let owner2: Wallet
  let owner3: Wallet

  before(async function () {
    entryPoint = await deployEntryPoint()
    owner1 = createAccountOwner()
    owner2 = createAccountOwner()
    owner3 = createAccountOwner()
  })

  async function deployMultiOwnerAccount (owners: string[]): Promise<MultiOwnerAccount> {
    const impl = await new MultiOwnerAccount__factory(ethersSigner).deploy(entryPoint.address)
    const proxy = await new ERC1967Proxy__factory(ethersSigner).deploy(
      impl.address,
      impl.interface.encodeFunctionData('initialize', [owners])
    )
    return MultiOwnerAccount__factory.connect(proxy.address, ethersSigner)
  }

  describe('initialization', () => {
    it('should initialize with multiple owners', async () => {
      const account = await deployMultiOwnerAccount([owner1.address, owner2.address])
      expect(await account.owners(owner1.address)).to.equal(true)
      expect(await account.owners(owner2.address)).to.equal(true)
      expect(await account.ownerCount()).to.equal(2)
    })

    it('should reject empty owner list', async () => {
      const impl = await new MultiOwnerAccount__factory(ethersSigner).deploy(entryPoint.address)
      await expect(
        new ERC1967Proxy__factory(ethersSigner).deploy(
          impl.address,
          impl.interface.encodeFunctionData('initialize', [[]])
        )
      ).to.be.reverted
    })
  })

  describe('owner management', () => {
    let account: MultiOwnerAccount

    before(async () => {
      account = await deployMultiOwnerAccount([owner1.address, owner2.address])
      await ethersSigner.sendTransaction({ to: account.address, value: parseEther('1') })
      await fund(owner1.address)
      await fund(owner2.address)
    })

    it('owner1 should be able to add owner3', async () => {
      await account.connect(owner1).addOwner(owner3.address)
      expect(await account.owners(owner3.address)).to.equal(true)
      expect(await account.ownerCount()).to.equal(3)
    })

    it('should reject adding an existing owner', async () => {
      await expect(account.connect(owner1).addOwner(owner1.address)).to.be.revertedWith('AlreadyOwner')
    })

    it('owner2 should be able to remove owner3', async () => {
      await account.connect(owner2).removeOwner(owner3.address)
      expect(await account.owners(owner3.address)).to.equal(false)
      expect(await account.ownerCount()).to.equal(2)
    })

    it('should not allow removing the last owner', async () => {
      await account.connect(owner1).removeOwner(owner2.address)
      await expect(account.connect(owner1).callStatic.removeOwner(owner1.address)).to.be.revertedWith('LastOwner')
      // restore
      await account.connect(owner1).addOwner(owner2.address)
    })

    it('non-owner should not be able to add an owner', async () => {
      const stranger = ethers.provider.getSigner(1)
      await expect(account.connect(stranger).callStatic.addOwner(owner3.address)).to.be.revertedWith('OnlyOwner')
    })
  })

  describe('#validateUserOp (signature verification)', () => {
    let account: MultiOwnerAccount

    before(async () => {
      account = await deployMultiOwnerAccount([owner1.address, owner2.address])
      await ethersSigner.sendTransaction({ to: account.address, value: parseEther('2') })
    })

    it('owner1 should be able to execute a UserOperation', async () => {
      const target = createAddress()
      const op = await fillAndSign({
        sender: account.address,
        callData: account.interface.encodeFunctionData('execute', [target, ONE_ETH, '0x'])
      }, owner1, entryPoint)
      const result = await entryPoint.handleOps([packUserOp(op)], createAddress())
        .then(async r => r.wait())
      const events = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), result.blockHash)
      expect(events[0].args.success).to.equal(true)
      expect(await ethers.provider.getBalance(target)).to.equal(ONE_ETH)
    })

    it('owner2 should also be able to execute a UserOperation', async () => {
      const target = createAddress()
      await ethersSigner.sendTransaction({ to: account.address, value: parseEther('1') })
      const op = await fillAndSign({
        sender: account.address,
        callData: account.interface.encodeFunctionData('execute', [target, ONE_ETH, '0x'])
      }, owner2, entryPoint)
      const result = await entryPoint.handleOps([packUserOp(op)], createAddress())
        .then(async r => r.wait())
      const events = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), result.blockHash)
      expect(events[0].args.success).to.equal(true)
    })

    it('non-owner should fail signature validation', async () => {
      const stranger = createAccountOwner()
      const op = await fillAndSign({
        sender: account.address,
        callData: '0x'
      }, stranger, entryPoint)
      await expect(entryPoint.handleOps([packUserOp(op)], createAddress())).to.be.revertedWith('AA24 signature error')
    })
  })

  describe('execute access control', () => {
    let account: MultiOwnerAccount

    before(async () => {
      account = await deployMultiOwnerAccount([owner1.address])
      await ethersSigner.sendTransaction({ to: account.address, value: parseEther('2') })
      await fund(owner1.address)
    })

    it('owner should be able to call execute directly', async () => {
      const target = createAddress()
      await account.connect(owner1).execute(target, ONE_ETH, '0x')
      expect(await ethers.provider.getBalance(target)).to.equal(ONE_ETH)
    })

    it('non-owner should not be able to call execute directly', async () => {
      const stranger = ethers.provider.getSigner(1)
      await expect(
        account.connect(stranger).callStatic.execute(createAddress(), ONE_ETH, '0x')
      ).to.be.revertedWith('OnlyOwnerOrEntryPoint')
    })
  })

  describe('MultiOwnerAccountFactory', () => {
    let factory: MultiOwnerAccountFactory

    before(async () => {
      factory = await new MultiOwnerAccountFactory__factory(ethersSigner).deploy(entryPoint.address)
    })

    it('should reject createAccount calls from non-SenderCreator', async () => {
      const signerAddr = await ethersSigner.getAddress()
      const senderCreator = await entryPoint.senderCreator()
      await expect(
        factory.createAccount([owner1.address], 0)
      ).to.be.revertedWith(`NotSenderCreator("${signerAddr}", "${factory.address}", "${senderCreator}")`)
    })

    it('getAddress should return deterministic address', async () => {
      const addr1 = await factory.getAddress([owner1.address, owner2.address], 42)
      const addr2 = await factory.getAddress([owner1.address, owner2.address], 42)
      expect(addr1).to.equal(addr2)
      expect(await isDeployed(addr1)).to.equal(false)
    })

    it('should deploy account when called by SenderCreator', async () => {
      const senderCreator = await entryPoint.senderCreator()
      await (ethersSigner.provider as JsonRpcProvider).send('hardhat_setBalance', [senderCreator, ethers.utils.hexValue(parseEther('100'))])
      const senderCreatorSigner = await ethers.getImpersonatedSigner(senderCreator)

      const owners = [owner1.address, owner2.address]
      const salt = 9999
      const addr = await factory.getAddress(owners, salt)
      expect(await isDeployed(addr)).to.equal(false)
      await factory.connect(senderCreatorSigner).createAccount(owners, salt)
      expect(await isDeployed(addr)).to.equal(true)

      const deployed = MultiOwnerAccount__factory.connect(addr, ethersSigner)
      expect(await deployed.owners(owner1.address)).to.equal(true)
      expect(await deployed.owners(owner2.address)).to.equal(true)
    })
  })
})
