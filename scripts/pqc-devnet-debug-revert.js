#!/usr/bin/env node
// Replays the failed handleOps call as eth_call against the block right
// before it landed, to decode the revert reason (FailedOp custom error,
// or whatever actually reverted) without spending gas again.

const { ethers } = require('ethers')

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:18545'
const TX_HASH = process.argv[2]

if (!TX_HASH) {
  console.error('Usage: node scripts/pqc-devnet-debug-revert.js <txHash>')
  process.exit(1)
}

async function main () {
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const tx = await provider.getTransaction(TX_HASH)
  if (!tx) {
    console.error('Transaction not found:', TX_HASH)
    process.exit(1)
  }

  const callRequest = {
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gasLimit: tx.gasLimit
  }

  try {
    const result = await provider.call(callRequest, tx.blockNumber)
    console.log('Call unexpectedly succeeded, returned:', result)
  } catch (err) {
    console.log('Raw error:', JSON.stringify(err, null, 2).slice(0, 4000))

    // ethers v5 JsonRpcProvider surfaces revert data in err.data or err.error.data
    const data = err.data || err?.error?.data || err?.body
    console.log('\nExtracted data field:', data)

    if (typeof data === 'string' && data.startsWith('0x')) {
      // Try decoding as EntryPoint's FailedOp(uint256,string) custom error.
      const iface = new ethers.utils.Interface([
        'error FailedOp(uint256 opIndex, string reason)',
        'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)'
      ])
      try {
        const decoded = iface.parseError(data)
        console.log('\nDecoded custom error:', decoded.name, decoded.args)
      } catch (decodeErr) {
        console.log('\nCould not decode as FailedOp/FailedOpWithRevert:', decodeErr.message)
        // Fall back to generic Error(string) selector 0x08c379a0
        if (data.startsWith('0x08c379a0')) {
          const reason = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + data.slice(10))
          console.log('Generic revert reason:', reason[0])
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
