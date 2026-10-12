import assert from 'node:assert/strict'
import { contractId, fromHex, hash, hex } from '@duskdomains/sdk'
import { committedEvents } from '@duskdomains/sdk/projection'

// A policy outside the release-verified first scope initializes in its own deployment
// transaction, before governance can admit it, so the projection never sees that event.
// The collector journals the deployment receipt once the policy is admitted, with the
// evidence it checked against the deploy transaction. Replay accepts it only for an
// admitted policy whose admission pins the same code hash and init hash.

const HEX32 = /^[0-9a-f]{64}$/
const fields = ['role', 'contractId', 'transaction', 'blockHeight', 'blockHash', 'codeHash', 'initArchive', 'deployNonce', 'deploymentOwner']

/** Spec §2.3: the admission's init_hash is H("duskds:init:v1" || canonical init archive). */
export function initializationHash(archive) {
  return hex(hash('duskds:init:v1', Uint8Array.from(archive)))
}

/** The single committed `policy_initialized` in a policy's deployment receipt. */
export function deploymentInitialization(receipt, policy) {
  assert(receipt.success === true && receipt.events.length > 0, 'Deployment receipt is empty or failed')
  for (const e of receipt.events) assert.equal(contractId(e.emitter), policy, 'Deployment receipt contains another emitter')
  const effects = committedEvents(receipt, { [policy]: 'policy' })
  assert(effects.length === 1 && effects[0].topic === 'policy_initialized',
    'Deployment receipt must commit exactly one policy initialization')
  return effects[0].data.body.args
}

export function validateInitializationEvidence(initialization) {
  assert(initialization && typeof initialization === 'object' && !Array.isArray(initialization), 'Invalid initialization evidence')
  assert.deepEqual(Object.keys(initialization).sort(), fields.toSorted(), 'Initialization evidence fields')
  assert.equal(initialization.role, 'policy', 'Only policy initializations are journaled')
  for (const key of ['contractId', 'transaction', 'blockHash', 'codeHash'])
    assert(typeof initialization[key] === 'string' && HEX32.test(initialization[key]), `Invalid initialization ${key}`)
  assert(Number.isSafeInteger(initialization.blockHeight) && initialization.blockHeight >= 0, 'Invalid initialization blockHeight')
  assert(typeof initialization.initArchive === 'string' && /^(?:[0-9a-f]{2})+$/.test(initialization.initArchive), 'Invalid init archive')
  assert(typeof initialization.deployNonce === 'string' && /^(0|[1-9][0-9]*)$/.test(initialization.deployNonce)
    && BigInt(initialization.deployNonce) <= 0xffffffffffffffffn, 'Invalid deployment nonce')
  assert(typeof initialization.deploymentOwner === 'string' && /^(?:[0-9a-f]{2})+$/.test(initialization.deploymentOwner), 'Invalid deployment owner')
  return initialization
}

/**
 * Accept a journaled deployment initialization for an admitted policy. Throws, and so
 * blocks replay like any rejected receipt, unless the policy is admitted, the receipt
 * commits exactly its own initialization at or before admission, the binding is this
 * directory's, and the admission pins the evidence's code hash and init archive.
 */
export function admitPolicyInitialization(projection, receipt, initialization, journaledHeight) {
  validateInitializationEvidence(initialization)
  const policy = contractId(initialization.contractId)
  assert(projection?.directory, 'Initialization before directory deployment')
  const admission = projection.admissions[policy]
  assert(projection.scope[policy] === 'policy' && admission, 'Initialization for a policy that is not admitted')
  assert.equal(receipt.id, `${initialization.blockHash}:${initialization.transaction}`, 'Initialization receipt identity')
  assert.equal(receipt.height, BigInt(initialization.blockHeight), 'Initialization receipt height')
  assert(receipt.height <= BigInt(admission.admitted_at) && receipt.height <= BigInt(journaledHeight),
    'Initialization must precede its admission and journal row')
  const args = deploymentInitialization(receipt, policy), binding = projection.directory.binding
  assert(hex(args.binding.directory) === hex(binding.directory) && hex(args.binding.vault) === hex(binding.vault)
    && args.binding.network === binding.network, 'Policy binding differs from the directory')
  const initHash = initializationHash(fromHex(initialization.initArchive))
  assert.equal(initialization.codeHash, hex(admission.code_hash), 'Policy code hash differs from its admission')
  assert.equal(initHash, hex(admission.init_hash), 'Policy init archive differs from its admission')
  return { policy, args, initHash, codeHash: initialization.codeHash }
}

/** Publish an authenticated configuration only while the current admission pins the same evidence. */
export function admittedInitialization(projection, policy, authenticated) {
  const admission = projection.admissions[policy]
  return authenticated && admission && authenticated.initHash === hex(admission.init_hash)
    && authenticated.codeHash === hex(admission.code_hash) ? authenticated.args : null
}

/**
 * The release-scoped policy initialized in scope, checked by the release manifest. Publish it only
 * while the selected admission still pins its genesis admission's ID and hashes.
 */
export function admittedGenesisInitialization(projection, policy) {
  const genesis = projection.initializations[projection.directoryId]?.policy, admission = projection.admissions[policy]
  return genesis && admission && contractId(genesis.id) === policy && hex(genesis.code_hash) === hex(admission.code_hash)
    && hex(genesis.init_hash) === hex(admission.init_hash) ? projection.policies[policy] ?? null : null
}
