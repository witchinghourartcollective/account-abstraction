import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers } from 'hardhat'

const deployVerifyingPaymaster: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const provider = ethers.provider
  const from = await provider.getSigner().getAddress()
  const network = await provider.getNetwork()

  // Only deploy on local test networks unless explicitly requested.
  const forceDeployPaymaster = process.argv.join(' ').match(/verifying-paymaster/) != null
  if (!forceDeployPaymaster && network.chainId !== 31337 && network.chainId !== 1337) {
    return
  }

  const entrypoint = await hre.deployments.get('EntryPoint')

  await hre.deployments.deploy('VerifyingPaymaster', {
    from,
    args: [entrypoint.address, from],
    gasLimit: 3e6,
    deterministicDeployment: true,
    log: true
  })
}

export default deployVerifyingPaymaster
