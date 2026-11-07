#!/usr/bin/env node
// Base Sepolia prototype: proves a PqcAccount (ML-DSA-65-gated ERC-4337
// account) can be a real WrappedHour bridge signer with ZERO changes to the
// already-deployed WrappedHour.sol / HourBridgeVault.sol contracts, because
// both gate signer identity by msg.sender rather than an off-chain ECDSA
// signature recovered via ecrecover.
//
// This uses TestMlDsaVerifier (the deterministic mock already in this repo,
// contracts/test/TestMlDsaVerifier.sol), NOT the real ZKNoxHQ ETHDILITHIUM
// verifier. That is a deliberate scope limit: this script proves the BRIDGE
// INTEGRATION pattern (PqcAccount as a msg.sender-based multisig signer), not
// ML-DSA-65 cryptographic correctness -- that was already proven separately
// on the hOUR devnet with the real verifier. Do not cite this script as
// evidence the real verifier works; see docs/CRYPTO-REVIEW-PACKET.md for that.
//
// Deploys a fresh TEST WrappedHour instance -- never touches the real
// mainnet bridge contracts or their signer/owner keys.
//
// Usage:
//   PRIVATE_KEY=0x... node scripts/base-sepolia-bridge-signer-prototype.js

const { ethers } = require('ethers')
const fs = require('fs')
const path = require('path')

const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org'
const PRIVATE_KEY = process.env.PRIVATE_KEY
const WRAPPED_HOUR_ARTIFACT_PATH = process.env.WRAPPED_HOUR_ARTIFACT_PATH ||
  '/home/fletchervaughn/witching-hour-token/artifacts/contracts/WrappedHour.sol/WrappedHour.json'

if (!PRIVATE_KEY) {
  console.error('Missing required env var: PRIVATE_KEY')
  process.exit(1)
}

function loadArtifact (relPath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', relPath), 'utf8'))
}

function packTwo (a, b) {
  return ethers.utils.hexZeroPad(ethers.BigNumber.from(a).toHexString(), 16).slice(2) +
         ethers.utils.hexZeroPad(ethers.BigNumber.from(b).toHexString(), 16).slice(2)
}

async function main () {
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider)
  console.log('Deployer/EOA signer:', wallet.address, 'balance:', ethers.utils.formatEther(await wallet.getBalance()), 'ETH')

  // ethers v5 getFeeData() pads a fixed ~1.5 gwei priority fee regardless of
  // actual network conditions, which overshoots badly on a cheap L2 testnet
  // (observed base fee here: ~0.005 gwei) and makes gas estimation fail
  // against a low-balance address. Use the real base fee instead, everywhere.
  const latestBlock = await provider.getBlock('latest')
  const baseFee = latestBlock.baseFeePerGas || ethers.utils.parseUnits('0.01', 'gwei')
  const maxPriorityFeePerGas = ethers.utils.parseUnits('0.01', 'gwei')
  const maxFeePerGas = baseFee.mul(2).add(maxPriorityFeePerGas)
  console.log('Using maxFeePerGas:', ethers.utils.formatUnits(maxFeePerGas, 'gwei'), 'gwei, maxPriorityFeePerGas:', ethers.utils.formatUnits(maxPriorityFeePerGas, 'gwei'), 'gwei')
  const ov = { maxFeePerGas, maxPriorityFeePerGas }

  const entryPointArtifact = loadArtifact('contracts/core/EntryPoint.sol/EntryPoint.json')
  const factoryArtifact = loadArtifact('contracts/pqc/PqcAccountFactory.sol/PqcAccountFactory.json')
  const accountArtifact = loadArtifact('contracts/pqc/PqcAccount.sol/PqcAccount.json')
  const verifierArtifact = loadArtifact('contracts/test/TestMlDsaVerifier.sol/TestMlDsaVerifier.json')
  const wrappedHourArtifact = JSON.parse(fs.readFileSync(WRAPPED_HOUR_ARTIFACT_PATH, 'utf8'))

  console.log('\n--- Deploying TestMlDsaVerifier (mock -- see header comment) ---')
  const verifierFactory = new ethers.ContractFactory(verifierArtifact.abi, verifierArtifact.bytecode, wallet)
  const verifier = await verifierFactory.deploy(ov)
  await verifier.deployed()
  console.log('TestMlDsaVerifier:', verifier.address)

  console.log('\n--- Deploying EntryPoint ---')
  const entryPointFactory = new ethers.ContractFactory(entryPointArtifact.abi, entryPointArtifact.bytecode, wallet)
  const entryPoint = await entryPointFactory.deploy(ov)
  await entryPoint.deployed()
  console.log('EntryPoint:', entryPoint.address)

  console.log('\n--- Deploying PqcAccountFactory ---')
  const pqcFactoryFactory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, wallet)
  const factory = await pqcFactoryFactory.deploy(entryPoint.address, verifier.address, ov)
  await factory.deployed()
  console.log('PqcAccountFactory:', factory.address)

  const pubkeyBlob = '0xdeadbeef' // arbitrary -- TestMlDsaVerifier.setKey is a pure passthrough
  const salt = 0
  const accountAddress = await factory.getAddress(pubkeyBlob, salt)
  console.log('\nCounterfactual PqcAccount address:', accountAddress)

  console.log('\n--- Funding the counterfactual account for its UserOp prefund ---')
  const fundTx = await wallet.sendTransaction({ to: accountAddress, value: ethers.utils.parseEther('0.0001'), ...ov })
  await fundTx.wait()
  console.log('Funded. tx:', fundTx.hash)

  const accountIface = new ethers.utils.Interface(accountArtifact.abi)
  const verificationGasLimit = 2_000_000
  const callGasLimit = 300_000
  const preVerificationGas = 100_000

  async function buildAndSubmitUserOp (label, { initCode, callData, signatureHint }) {
    const userOp = {
      sender: accountAddress,
      nonce: await entryPoint.getNonce(accountAddress, 0),
      initCode: initCode || '0x',
      callData,
      accountGasLimits: '0x' + packTwo(verificationGasLimit, callGasLimit),
      preVerificationGas,
      gasFees: '0x' + packTwo(maxPriorityFeePerGas, maxFeePerGas),
      paymasterAndData: '0x',
      signature: '0x'
    }
    const userOpHash = await entryPoint.getUserOpHash(userOp)
    const signature = signatureHint || ethers.utils.hexlify(ethers.utils.randomBytes(32))
    userOp.signature = signature

    // Pre-authorize this exact (pk, userOpHash, signature) triple in the mock verifier.
    // pk as PqcAccount will see it: verifier.setKey(pubkeyBlob) output (pure passthrough == pubkeyBlob).
    const setResultTx = await verifier.setResult(pubkeyBlob, userOpHash, signature, true, ov)
    await setResultTx.wait()

    console.log(`\n--- ${label}: submitting via EntryPoint.handleOps ---`)
    console.log('UserOpHash:', userOpHash)
    const tx = await entryPoint.handleOps([userOp], wallet.address, { gasLimit: 3_000_000, ...ov })
    const receipt = await tx.wait()
    console.log(`${label} tx:`, tx.hash, 'status:', receipt.status, 'gasUsed:', receipt.gasUsed.toString())
    return receipt
  }

  const initCode = ethers.utils.hexConcat([
    factory.address,
    factory.interface.encodeFunctionData('createAccount', [pubkeyBlob, salt])
  ])
  const noopCallData = accountIface.encodeFunctionData('execute', [wallet.address, 0, '0x'])
  await buildAndSubmitUserOp('Create PqcAccount', { initCode, callData: noopCallData })

  const deployedCode = await provider.getCode(accountAddress)
  console.log('\nPqcAccount deployed:', deployedCode !== '0x', '(', (deployedCode.length - 2) / 2, 'bytes )')

  console.log('\n--- Deploying a TEST-ONLY WrappedHour (not the real bridge) ---')
  // Third signer is a never-confirming placeholder -- WrappedHour requires MIN_SIGNERS=3.
  const thirdSignerPlaceholder = ethers.Wallet.createRandom().address
  const whFactory = new ethers.ContractFactory(wrappedHourArtifact.abi, wrappedHourArtifact.bytecode, wallet)
  const wrappedHour = await whFactory.deploy(
    [accountAddress, wallet.address, thirdSignerPlaceholder],
    2, // threshold: PqcAccount + existing EOA signer satisfies 2-of-3, proving a mixed quorum
    wallet.address, // owner, test-only
    ov
  )
  await wrappedHour.deployed()
  console.log('Test WrappedHour:', wrappedHour.address)
  console.log('Signers: PqcAccount=', accountAddress, ' EOA=', wallet.address, ' placeholder=', thirdSignerPlaceholder)

  const lockId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('base-sepolia-pqc-bridge-prototype'))
  const mintTo = wallet.address
  const amount = ethers.utils.parseEther('1')

  console.log('\n--- EOA signer confirms first (1/2) ---')
  const confirm1Tx = await wrappedHour.confirmMint(lockId, mintTo, amount, ov)
  await confirm1Tx.wait()
  console.log('EOA confirmMint tx:', confirm1Tx.hash)

  console.log('\n--- PqcAccount confirms via a validated UserOperation (2/2, should trigger mint) ---')
  const confirmCallData = accountIface.encodeFunctionData('execute', [
    wrappedHour.address,
    0,
    wrappedHour.interface.encodeFunctionData('confirmMint', [lockId, mintTo, amount])
  ])
  await buildAndSubmitUserOp('PqcAccount confirmMint', { callData: confirmCallData })

  const balance = await wrappedHour.balanceOf(mintTo)
  const mint = await wrappedHour.mints(lockId)
  console.log('\n=== RESULT ===')
  console.log('whOUR balance of', mintTo, ':', ethers.utils.formatEther(balance))
  console.log('Mint record processed:', mint.processed, 'confirmations:', mint.confirmations.toString())
  console.log('PROOF: a PQ-gated ERC-4337 smart account acted as a real WrappedHour bridge signer,')
  console.log('alongside an existing EOA signer, with ZERO changes to WrappedHour.sol:', mint.processed)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
