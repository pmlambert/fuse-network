const path = require('path')
const cwd = process.cwd()
const logger = require('pino')({ level: process.env.LOG_LEVEL || 'info', prettyPrint: { translateTime: true } })
const fs = require('fs')
const HDWalletProvider = require('truffle-hdwallet-provider')
const EthWallet = require('ethereumjs-wallet')
const Web3 = require('web3')
const ethers = require('ethers')
const { sign, signFuse } = require('./utils')

const configDir = path.join(cwd, process.env.CONFIG_DIR || 'config/')

let web3
let walletProvider
let account
let consensus, blockReward, blockRegistry
let blockchains = {}

function initWalletProvider(rpc) {
  logger.info(`initWalletProvider`)
  let keystoreDir = path.join(configDir, 'keys/FuseNetwork')
  let keystore
  fs.readdirSync(keystoreDir).forEach(file => {
    if (file.startsWith('UTC')) {
      keystore = fs.readFileSync(path.join(keystoreDir, file)).toString()
    }
  })
  let password = fs.readFileSync(path.join(configDir, 'pass.pwd')).toString().trim()
  let wallet = EthWallet.fromV3(keystore, password)
  let pkey = wallet.getPrivateKeyString()
  walletProvider = new HDWalletProvider(pkey, rpc || process.env.RPC)
  if (!walletProvider) {
    throw new Error(`Could not set walletProvider for unknown reason`)
  } else {
    account = walletProvider.addresses[0]
    logger.info(`account: ${account}`)
    web3 = new Web3(walletProvider)
  }
}
function initBlockchain(chainId, rpc) {
  logger.info('initBlockchain')
  let keystoreDir = path.join(configDir, 'keys/FuseNetwork')
  let keystore
  fs.readdirSync(keystoreDir).forEach(file => {
    if (file.startsWith('UTC')) {
      keystore = fs.readFileSync(path.join(keystoreDir, file)).toString()
    }
  })
  let password = fs.readFileSync(path.join(configDir, 'pass.pwd')).toString().trim()
  let wallet = EthWallet.fromV3(keystore, password)
  let pkey = wallet.getPrivateKeyString()
  blockchains[chainId] = {
    account: walletProvider.addresses[0],
    web3: new Web3(walletProvider),
    rpc,
    signer: new ethers.Wallet(pkey)
  }
}

async function getNonce() {
  try {
    logger.debug(`getNonce for ${account}`)
    const transactionCount = await web3.eth.getTransactionCount(account)
    logger.debug(`transactionCount for ${account} is ${transactionCount}`)
    return transactionCount
  } catch (e) {
    throw new Error(`Could not get nonce`)
  }
}

function initConsensusContract() {
  logger.info(`initConsensusContract`, process.env.CONSENSUS_ADDRESS)
  consensus = new web3.eth.Contract(require(path.join(cwd, 'abi/consensus')), process.env.CONSENSUS_ADDRESS)
}

function initBlockRewardContract() {
  logger.info(`initBlockRewardContract`, process.env.BLOCK_REWARD_ADDRESS)
  blockReward = new web3.eth.Contract(require(path.join(cwd, 'abi/blockReward')), process.env.BLOCK_REWARD_ADDRESS)
}
function initBlockRegistryContract() {
  logger.info(`initBlockRegistryContract`, process.env.BLOCK_REGISTRY_ADDRESS)
  blockRegistry = new web3.eth.Contract(require(path.join(cwd, 'abi/blockRegistry')), process.env.BLOCK_REGISTRY_ADDRESS)
}

function emitInitiateChange() {
  return new Promise(async (resolve, reject) => {
    try {
      logger.info(`emitInitiateChange`)
      let currentBlockNumber = await web3.eth.getBlockNumber()
      let currentCycleEndBlock = (await consensus.methods.getCurrentCycleEndBlock.call()).toNumber()
      let shouldEmitInitiateChange = await consensus.methods.shouldEmitInitiateChange.call()
      logger.info(`block #${currentBlockNumber}\n\tcurrentCycleEndBlock: ${currentCycleEndBlock}\n\tshouldEmitInitiateChange: ${shouldEmitInitiateChange}`)
      if (!shouldEmitInitiateChange) {
        return resolve()
      }
      logger.info(`${account} sending emitInitiateChange transaction`)
      let nonce = await getNonce()
      consensus.methods.emitInitiateChange().send({ from: account, gas: process.env.GAS || 1000000, gasPrice: process.env.GAS_PRICE || '0', nonce: nonce })
        .on('transactionHash', hash => {
          logger.info(`transactionHash: ${hash}`)
        })
        .on('confirmation', (confirmationNumber, receipt) => {
          if (confirmationNumber == 1) {
            logger.debug(`receipt: ${JSON.stringify(receipt)}`)
          }
          resolve()
        })
        .on('error', error => {
          logger.error(error); resolve()
        })
    } catch (e) {
      reject(e)
    }
  })
}

function emitRewardedOnCycle() {
  return new Promise(async (resolve, reject) => {
    try {
      logger.info(`emitRewardedOnCycle`)
      let currentBlockNumber = await web3.eth.getBlockNumber()
      let currentCycleEndBlock = (await consensus.methods.getCurrentCycleEndBlock.call()).toNumber()
      let shouldEmitRewardedOnCycle = await blockReward.methods.shouldEmitRewardedOnCycle.call()
      logger.info(`block #${currentBlockNumber}\n\tcurrentCycleEndBlock: ${currentCycleEndBlock}\n\tshouldEmitRewardedOnCycle: ${shouldEmitRewardedOnCycle}`)
      if (!shouldEmitRewardedOnCycle) {
        return resolve()
      }
      logger.info(`${account} sending emitRewardedOnCycle transaction`)
      let nonce = await getNonce()
      blockReward.methods.emitRewardedOnCycle().send({ from: account, gas: process.env.GAS || 1000000, gasPrice: process.env.GAS_PRICE || '0', nonce: nonce })
        .on('transactionHash', hash => {
          logger.info(`transactionHash: ${hash}`)
        })
        .on('confirmation', (confirmationNumber, receipt) => {
          if (confirmationNumber == 1) {
            logger.debug(`receipt: ${JSON.stringify(receipt)}`)
          }
          resolve()
        })
        .on('error', error => {
          logger.error(error); resolve()
        })
    } catch (e) {
      reject(e)
    }
  })
}

async function emitRegistry() {
  logger.info('emitRegistry')
  const chains = await blockRegistry.getPastEvents('Blockchain', {fromBlock:0,toBlock:'latest'})
  await Promise.all(chains.filter(chain => blockchains[chain[0]].rpc != chain[1] || !blockchains[chain[0]]).map(async (chain) => initBlockchain(...chain)))
  const blocks = await Promise.all(Object.entries(blockchains).map(async ([chainId, blockchain]) => {
    const { web3: _web3, signer } = blockchain
    const latestBlock = await _web3.eth.getBlock('latest')
    if (chainId == 122) {
      let cycleEnd = (await consensus.methods.getCurrentCycleEndBlock.call()).toNumber()
      let numValidators = (await consensus.methods.currentValidatorsLength.call()).toNumber()
      const validators = await Promise.all(new Array(numValidators).map(async (_, i) => await consensus.methods.currentValidatorsAtPosition.call()))
      return await signFuse(latestBlock, chainId, provider, signer, cycleEnd, validators)
    }
    return await sign(latestBlock, chainId, provider, signer)
  }))
  await blockRegistry.addSignedBlocks.call(blocks)
}

async function runMain() {
  try {
    logger.info(`runMain`)
    if (!walletProvider) {
      initWalletProvider()
    }
    if (!consensus) {
      initConsensusContract()
    }
    if (!blockReward) {
      initBlockRewardContract()
    }
    if (!blockRegistry) {
      initBlockRegistryContract()
    }
    const isValidator = await consensus.methods.isValidator(web3.utils.toChecksumAddress(account)).call()
    if (!isValidator) {
      logger.warn(`${account} is not a validator, skipping`)
      return
    }
    await emitInitiateChange()
    await emitRewardedOnCycle()
    await emitRegistry()
  } catch (e) {
    logger.error(e)
    process.exit(1)
  }

  setTimeout(() => {
    runMain()
  }, process.env.POLLING_INTERVAL || 2500)
}

runMain()
