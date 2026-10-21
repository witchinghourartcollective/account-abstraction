#!/usr/bin/env node
// Standalone devnet script: deploys EntryPoint + PqcAccountFactory (plain
// CREATE, not CREATE2 -- the devnet has no deterministic-deployer-proxy
// singleton, same fix as ETHDILITHIUM's deploy scripts needed), creates a
// real PqcAccount via a signed UserOperation, and executes a trivial call
// through it -- end-to-end proof that ML-DSA-65 account validation works
// against the real deployed verifier, not a mock.
//
// Run with plain `node` (not hardhat) so it doesn't fight hardhat-deploy's
// own CREATE2 conventions, which have the same missing-proxy problem.
//
// Usage:
//   HOURCHAIN_PRIVATE_KEY=0x... VERIFIER=0xe2F81B... \
//   PUBKEY_BLOB_FILE=/path/to/pqc-devnet-setkey-blob.json \
//   SIGNER_SECRET_KEY=0x... \
//   node scripts/pqc-devnet-create-account.js

const { ethers } = require('ethers')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:18545'
const PRIVATE_KEY = process.env.HOURCHAIN_PRIVATE_KEY
const VERIFIER = process.env.VERIFIER
const PUBKEY_BLOB_FILE = process.env.PUBKEY_BLOB_FILE
const SIGNER_SECRET_KEY = process.env.SIGNER_SECRET_KEY
const ETHDILITHIUM_DIR = process.env.ETHDILITHIUM_DIR ||
  '/tmp/claude-1000/-home-fletchervaughn/9b74065a-892b-4cad-908f-2faa6d0c3fa9/scratchpad/ETHDILITHIUM-65'

if (!PRIVATE_KEY || !VERIFIER || !PUBKEY_BLOB_FILE || !SIGNER_SECRET_KEY) {
  console.error('Missing required env vars: HOURCHAIN_PRIVATE_KEY, VERIFIER, PUBKEY_BLOB_FILE, SIGNER_SECRET_KEY')
  process.exit(1)
}

function loadArtifact (relPath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', relPath), 'utf8'))
}

function packTwo (a, b) {
  // packAccountGasLimits / packs two uint128-ish values into one bytes32,
  // matching UserOperationLib's packing (high 128 bits = a, low 128 = b).
  return ethers.utils.hexZeroPad(ethers.BigNumber.from(a).toHexString(), 16).slice(2) +
         ethers.utils.hexZeroPad(ethers.BigNumber.from(b).toHexString(), 16).slice(2)
}

async function main () {
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider)
  console.log('Deployer:', wallet.address, 'balance:', (await wallet.getBalance()).toString())

  const entryPointArtifact = loadArtifact('contracts/core/EntryPoint.sol/EntryPoint.json')
  const factoryArtifact = loadArtifact('contracts/pqc/PqcAccountFactory.sol/PqcAccountFactory.json')
  const accountArtifact = loadArtifact('contracts/pqc/PqcAccount.sol/PqcAccount.json')

  console.log('\n--- Deploying EntryPoint (plain CREATE) ---')
  const entryPointFactory = new ethers.ContractFactory(entryPointArtifact.abi, entryPointArtifact.bytecode, wallet)
  const entryPoint = await entryPointFactory.deploy({ gasLimit: 9_000_000 })
  await entryPoint.deployed()
  console.log('EntryPoint:', entryPoint.address)

  console.log('\n--- Deploying PqcAccountFactory (plain CREATE) ---')
  const pqcFactoryFactory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, wallet)
  const factory = await pqcFactoryFactory.deploy(entryPoint.address, VERIFIER, { gasLimit: 9_000_000 })
  await factory.deployed()
  console.log('PqcAccountFactory:', factory.address)

  const pubkeyBlob = JSON.parse(fs.readFileSync(PUBKEY_BLOB_FILE, 'utf8')).setKeyData
  const salt = 0

  const accountAddress = await factory.getAddress(pubkeyBlob, salt)
  console.log('\nCounterfactual PqcAccount address:', accountAddress)

  console.log('\n--- Funding the counterfactual account for its UserOp prefund ---')
  const fundTx = await wallet.sendTransaction({ to: accountAddress, value: ethers.utils.parseEther('0.01'), gasLimit: 100_000 })
  await fundTx.wait()
  console.log('Funded. tx:', fundTx.hash)

  console.log('\n--- Building the UserOperation ---')
  const initCode = ethers.utils.hexConcat([
    factory.address,
    factory.interface.encodeFunctionData('createAccount', [pubkeyBlob, salt])
  ])
  // Trivial no-op execute: call back to the deployer with 0 value, 0 data.
  const accountIface = new ethers.utils.Interface(accountArtifact.abi)
  const callData = accountIface.encodeFunctionData('execute', [wallet.address, 0, '0x'])

  const verificationGasLimit = 9_200_000 // setKey alone needs ~8.45M
  const callGasLimit = 300_000
  const preVerificationGas = 100_000
  const maxFeePerGas = ethers.utils.parseUnits('10', 'gwei')
  const maxPriorityFeePerGas = ethers.utils.parseUnits('1', 'gwei')

  const userOp = {
    sender: accountAddress,
    nonce: 0,
    initCode,
    callData,
    accountGasLimits: '0x' + packTwo(verificationGasLimit, callGasLimit),
    preVerificationGas,
    gasFees: '0x' + packTwo(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: '0x',
    signature: '0x'
  }

  const userOpHash = await entryPoint.getUserOpHash(userOp)
  console.log('UserOpHash:', userOpHash)

  console.log('\n--- Signing the UserOpHash with the real ML-DSA-65 secret key ---')
  const sigResult = JSON.parse(execFileSync(
    'node',
    [path.join(ETHDILITHIUM_DIR, 'js/sign65.js'), 'sign-hash', SIGNER_SECRET_KEY, userOpHash],
    { cwd: ETHDILITHIUM_DIR, maxBuffer: 1024 * 1024 * 10 }
  ).toString())
  userOp.signature = sigResult.signature
  console.log('Signature length (bytes):', (userOp.signature.length - 2) / 2)

  console.log('\n--- Submitting via EntryPoint.handleOps ---')
  const handleOpsTx = await entryPoint.handleOps([userOp], wallet.address, { gasLimit: 9_900_000 })
  const receipt = await handleOpsTx.wait()
  console.log('handleOps tx:', handleOpsTx.hash, 'status:', receipt.status, 'gasUsed:', receipt.gasUsed.toString())

  const deployedCode = await provider.getCode(accountAddress)
  console.log('\nPqcAccount deployed code length:', (deployedCode.length - 2) / 2, 'bytes')
  console.log('Account successfully created and validated by a real ML-DSA-65 UserOperation signature:', deployedCode !== '0x')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
