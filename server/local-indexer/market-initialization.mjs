import assert from 'node:assert/strict'
import { contractId, fromHex, hex } from '@duskdomains/sdk'
import { committedEvents } from '@duskdomains/sdk/projection'
import { initializationHash } from './policy-initialization.mjs'

// A marketplace admitted after launch is deployed, and can be configured (`set_fee`), before
// governance admits it, outside the collected scope. Every `market_configured` carries its
// complete configuration, so the last one before admission is its state at admission. The
// collector journals that receipt once the market is admitted, with the deployment evidence it
// checked. Replay accepts it only for an admitted market whose record pins the same hashes.

const HEX32 = /^[0-9a-f]{64}$/
const fields = ['role', 'contractId', 'transaction', 'blockHeight', 'blockHash', 'codeHash', 'initArchive', 'deployNonce', 'deploymentOwner',
  'configTransaction', 'configBlockHeight', 'configBlockHash']

/** The configuration a market's own receipt commits: only `market_configured`, the last one wins. */
export function committedMarketConfig(receipt, market) {
  assert(receipt.success === true && receipt.events.length > 0, 'Marketplace receipt is empty or failed')
  for (const e of receipt.events) assert.equal(contractId(e.emitter), market, 'Marketplace receipt contains another emitter')
  const effects = committedEvents(receipt, { [market]: 'marketplace' })
  assert(effects.length > 0 && effects.every(e => e.topic === 'market_configured'), 'Marketplace receipt must commit only its configuration')
  return effects.at(-1).data.body.config
}

export function validateMarketEvidence(initialization) {
  assert(initialization && typeof initialization === 'object' && !Array.isArray(initialization), 'Invalid initialization evidence')
  assert.deepEqual(Object.keys(initialization).sort(), fields.toSorted(), 'Marketplace initialization evidence fields')
  assert.equal(initialization.role, 'marketplace', 'Not a marketplace initialization')
  for (const key of ['contractId', 'transaction', 'blockHash', 'codeHash', 'configTransaction', 'configBlockHash'])
    assert(typeof initialization[key] === 'string' && HEX32.test(initialization[key]), `Invalid initialization ${key}`)
  for (const key of ['blockHeight', 'configBlockHeight'])
    assert(Number.isSafeInteger(initialization[key]) && initialization[key] >= 0, `Invalid initialization ${key}`)
  assert(typeof initialization.initArchive === 'string' && /^(?:[0-9a-f]{2})+$/.test(initialization.initArchive), 'Invalid init archive')
  assert(typeof initialization.deployNonce === 'string' && /^(0|[1-9][0-9]*)$/.test(initialization.deployNonce)
    && BigInt(initialization.deployNonce) <= 0xffffffffffffffffn, 'Invalid deployment nonce')
  assert(typeof initialization.deploymentOwner === 'string' && /^(?:[0-9a-f]{2})+$/.test(initialization.deploymentOwner), 'Invalid deployment owner')
  return initialization
}

/**
 * Accept a journaled pre-admission configuration for an admitted marketplace. Throws, and so
 * blocks replay like any rejected receipt, unless the market is admitted, the receipt commits
 * only its own configuration after its deployment and at or before its admission and journal
 * row, the binding is this directory's, and the market's record pins the evidence's code hash
 * and init archive.
 */
export function admitMarketInitialization(projection, receipt, initialization, journaledHeight, admittedAt) {
  validateMarketEvidence(initialization)
  const market = contractId(initialization.contractId)
  assert(projection?.directory, 'Initialization before directory deployment')
  const record = projection.markets[market]
  assert(projection.scope[market] === 'marketplace' && record && admittedAt !== undefined, 'Initialization for a marketplace that is not admitted')
  assert.equal(receipt.id, `${initialization.configBlockHash}:${initialization.configTransaction}`, 'Initialization receipt identity')
  assert.equal(receipt.height, BigInt(initialization.configBlockHeight), 'Initialization receipt height')
  assert(BigInt(initialization.blockHeight) <= receipt.height && receipt.height <= BigInt(admittedAt) && receipt.height <= BigInt(journaledHeight),
    'Configuration must follow deployment and precede its admission and journal row')
  const config = committedMarketConfig(receipt, market), binding = projection.directory.binding
  assert(hex(config.binding.directory) === hex(binding.directory) && hex(config.binding.vault) === hex(binding.vault)
    && config.binding.network === binding.network, 'Marketplace binding differs from the directory')
  const initHash = initializationHash(fromHex(initialization.initArchive))
  assert.equal(initialization.codeHash, hex(record.code_hash), 'Marketplace code hash differs from its record')
  assert.equal(initHash, hex(record.init_hash), 'Marketplace init archive differs from its record')
  return { market, config, initHash, codeHash: initialization.codeHash }
}

/** Serve an authenticated configuration only while the directory's record pins the same evidence. */
export function admittedMarketConfig(projection, market, authenticated) {
  const record = projection.markets[market]
  return authenticated && record && authenticated.initHash === hex(record.init_hash)
    && authenticated.codeHash === hex(record.code_hash) ? authenticated.config : null
}
