import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers } from 'hardhat'

const deployMultiOwnerAccountFactory: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const provider = ethers.provider
  const from = await provider.getSigner().getAddress()
  const network = await provider.getNetwork()

  // Only deploy on local test networks unless explicitly requested.
  const forceDeployFactory = process.argv.join(' ').match(/multi-owner-account-factory/) != null
  if (!forceDeployFactory && network.chainId !== 31337 && network.chainId !== 1337) {
    return
  }

  const entrypoint = await hre.deployments.get('EntryPoint')

  await hre.deployments.deploy('MultiOwnerAccountFactory', {
    from,
    args: [entrypoint.address],
    gasLimit: 6e6,
    deterministicDeployment: true,
    log: true
  })
}

export default deployMultiOwnerAccountFactory
