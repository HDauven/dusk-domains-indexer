import assert from 'node:assert/strict'
import { blake3 } from '@noble/hashes/blake3.js'
import { contractId, hash, hex, stringifyJson } from '@duskdomains/sdk'
import { deploymentInitialization, initializationHash } from '../../server/local-indexer/policy-initialization.mjs'
import { encodeReceipt } from '../../server/local-indexer/receipt-codec.mjs'
import { jsonSafe, topicsFor } from './frozen.mjs'

const HEX32 = /^[0-9a-f]{64}$/
const policyTopics = new Set(topicsFor('policy'))

/**
 * Decode a Rusk 1.7 Moonlight deployment (`tx.raw`): tag 1 (Aegis) or tag 3 with Boreas
 * format version 2, then the length-prefixed payload and a 48-byte signature. Layout:
 * dusk-core `moonlight::Payload::to_var_bytes` and `ContractDeploy::to_var_bytes`.
 */
export function parseDeployTransaction(rawHex) {
  assert(typeof rawHex === 'string' && /^(?:[0-9a-f]{2})+$/.test(rawHex), 'Deployment bytes must be hex')
  const raw = Buffer.from(rawHex, 'hex')
  let at = 0
  const take = n => {
    assert(Number.isSafeInteger(n) && n >= 0 && at + n <= raw.length, 'Truncated deployment transaction')
    const bytes = raw.subarray(at, at + n)
    at += n
    return bytes
  }
  const u8 = () => take(1)[0]
  const u64 = () => take(8).readBigUInt64LE(0)
  const length = () => {
    const n = u64()
    assert(n <= BigInt(raw.length), 'Deployment length exceeds the transaction')
    return Number(n)
  }
  const flag = () => {
    const value = u8()
    assert(value === 0 || value === 1, 'Invalid deployment option flag')
    return value === 1
  }
  const tag = u8()
  if (tag === 3) assert.equal(u8(), 2, 'Unsupported Boreas transaction format')
  else assert.equal(tag, 1, 'Deployment is not a Moonlight transaction')
  const payloadEnd = length() + at
  const chainId = u8()
  take(96) // sender
  if (flag()) take(96) // receiver
  take(32) // value, deposit, gas limit, gas price
  if (flag()) take(96) // refund address
  take(8) // account nonce
  assert.equal(u8(), 2, 'Transaction carries no contract deployment')
  const bytecodeHash = hex(take(32))
  const bytecode = Uint8Array.from(take(length()))
  const owner = Uint8Array.from(take(length()))
  const initArgs = flag() ? Uint8Array.from(take(length())) : null
  const deployNonce = u64()
  assert.equal(at, payloadEnd, 'Deployment payload length mismatch')
  assert.equal(raw.length - at, 48, 'Deployment signature length mismatch')
  return { chainId, bytecodeHash, bytecode, owner, initArgs, deployNonce }
}

/** H9: contract ID = H(bytecode || nonce_u64_le || owner). */
export function deploymentContractId({ bytecode, deployNonce, owner }) {
  const nonce = Buffer.alloc(8)
  nonce.writeBigUInt64LE(deployNonce)
  return hex(hash(bytecode, Uint8Array.from(nonce), owner))
}

const rejected = (code, message) => ({ rejected: { code, message } })

/**
 * Asked again with backoff, as they say nothing about the chain: the archive may not have the
 * deployment yet (Rusk can report a block final before its events reach `finalizedEvents`, and a
 * transaction index can lag), may answer for a block the collected chain does not hold, or a
 * lookup may fail outright (`lookup_failed`). Every other rejection is a fact about the chain.
 */
export const unavailableInitialization = new Set(['initialization_not_found', 'deployment_not_found', 'deployment_not_canonical',
  'deployment_not_included', 'lookup_failed'])

/**
 * Authenticate an admitted policy's initialization from its deployment, as the protocol's
 * admission evidence check does off chain: the deployed bytecode, nonce and owner derive
 * the admitted ID, the bytecode matches the admitted code hash, the actual init archive
 * matches the admitted init hash, and the policy's journaled initialization encodes to
 * exactly that archive. Contract IDs don't bind init arguments, so a deployment of the same ID
 * in a block the chain did not keep could carry the admitted init while the canonical one
 * carries another: the deployment must sit in the collected chain's block at its height
 * (`canonicalHash`, which the collector links to the blocks it verified), and that block must
 * list the transaction. The archive's own answers never vouch for each other.
 * Returns `{ receipt, initialization }` or `{ rejected }`. Archive transport and malformed
 * answers throw; the collector fails that policy closed and asks again.
 */
export async function fetchPolicyInitialization({ query, blockEvents, canonicalHash, policy, admission, admittedAt, driver, directoryId, vaultId }) {
  policy = contractId(policy)
  const located = (await query(`{finalizedEvents(contractId:"${policy}",limit:1){json}}`)).finalizedEvents?.json
  assert(located && Array.isArray(located.events), 'Archive finalizedEvents response is malformed')
  const first = located.events[0]
  if (!first) return rejected('initialization_not_found', `The archive has no events for policy ${policy}`)
  assert(first.source === policy && Number.isSafeInteger(first.block_height) && HEX32.test(first.block_hash ?? '')
    && HEX32.test(first.origin ?? ''), 'Archive finalizedEvents row is malformed')
  if (BigInt(first.block_height) > BigInt(admittedAt))
    return rejected('initialization_after_admission', `Policy ${policy} first emitted after its admission`)
  const canonical = await canonicalHash(first.block_height)
  assert(HEX32.test(canonical ?? ''), `No collected block at ${first.block_height}`)
  const notCanonical = hash => rejected('deployment_not_canonical',
    `Policy ${policy} deployment is placed in block ${hash} at ${first.block_height}; the collected chain has ${canonical}`)
  if (first.block_hash !== canonical) return notCanonical(first.block_hash)

  const spent = (await query(`{tx(hash:"${first.origin}"){id blockHeight blockHash err tx{id isDeploy contractId raw}}}`)).tx
  if (!spent) return rejected('deployment_not_found', `The node has no transaction ${first.origin} for policy ${policy}`)
  if (spent.blockHeight !== first.block_height || spent.blockHash !== canonical) return notCanonical(spent.blockHash)
  if (spent.id !== first.origin || spent.err !== null || spent.tx?.isDeploy !== true || spent.tx.contractId !== policy)
    return rejected('deployment_mismatch', `Transaction ${first.origin} is not the successful deployment of policy ${policy}`)
  let deploy
  try { deploy = parseDeployTransaction(spent.tx.raw) } catch (error) {
    return rejected('deployment_invalid', `Deployment ${first.origin}: ${error.message}`)
  }
  if (deploymentContractId(deploy) !== policy)
    return rejected('contract_id_mismatch', `Deployment ${first.origin} does not derive policy ${policy}`)
  const codeHash = hex(blake3(deploy.bytecode))
  if (codeHash !== deploy.bytecodeHash || codeHash !== hex(admission.code_hash))
    return rejected('code_hash_mismatch', `Policy ${policy} bytecode differs from its admitted code hash`)
  if (!deploy.initArgs || initializationHash(deploy.initArgs) !== hex(admission.init_hash))
    return rejected('init_hash_mismatch', `Policy ${policy} init archive differs from its admitted init hash`)

  const blocks = (await query(`{blocks(range:[${first.block_height},${first.block_height}]){header{height hash prevBlockHash timestamp} transactions{id}}}`)).blocks
  assert(Array.isArray(blocks) && blocks.length === 1 && blocks[0].header?.height === first.block_height
    && Array.isArray(blocks[0].transactions), `Deployment block ${first.block_height} is unavailable`)
  if (blocks[0].header.hash !== canonical) return notCanonical(blocks[0].header.hash)
  if (!blocks[0].transactions.some(t => t?.id === first.origin))
    return rejected('deployment_not_included', `Block ${canonical} does not list deployment ${first.origin} of policy ${policy}`)
  const events = []
  for (const [ordinal, raw] of (await blockEvents(blocks[0])).entries()) {
    if (raw.origin !== first.origin || raw.source !== policy) continue
    assert.equal(typeof raw.reverted, 'boolean', 'Archive event lacks rollback metadata')
    if (raw.reverted) continue
    if (!policyTopics.has(raw.topic)) return rejected('initialization_receipt_invalid', `Policy ${policy} emitted ${raw.topic} at deployment`)
    assert(typeof raw.data === 'string' && /^(?:[0-9a-f]{2})*$/i.test(raw.data), 'Invalid archive event bytes')
    let data
    // The reviewed v1 driver must decode a conforming policy; anything else fails closed.
    try { data = driver.decodeEvent(raw.topic, Buffer.from(raw.data, 'hex')) } catch (error) {
      return rejected('initialization_receipt_invalid', `Policy ${policy} ${raw.topic}: ${error.message}`)
    }
    events.push({ emitter: policy, topic: raw.topic, data, reverted: false, ordinal })
  }
  const receipt = { id: `${first.block_hash}:${first.origin}`, height: BigInt(first.block_height), success: true, events }
  let args
  try { args = deploymentInitialization(receipt, policy) } catch (error) {
    return rejected('initialization_receipt_invalid', `Policy ${policy}: ${error.message}`)
  }
  let archive = null
  try { archive = hex(driver.encodeInput('init', stringifyJson(args))) } catch { /* rejected below */ }
  if (archive !== hex(deploy.initArgs))
    return rejected('initialization_event_mismatch', `Policy ${policy} initialization event differs from its init archive`)
  if (hex(args.binding.directory) !== directoryId || (vaultId && hex(args.binding.vault) !== vaultId) || args.binding.network !== deploy.chainId)
    return rejected('binding_mismatch', `Policy ${policy} is bound to another deployment`)
  return { receipt, initialization: {
    role: 'policy', contractId: policy, transaction: first.origin, blockHeight: first.block_height, blockHash: first.block_hash,
    codeHash, initArchive: hex(deploy.initArgs), deployNonce: String(deploy.deployNonce), deploymentOwner: hex(deploy.owner),
  } }
}

/**
 * The journal row for an authenticated initialization. Its metadata names the block at which
 * the collector journaled it (the admitting block, or the committed block when catching up);
 * the receipt and `initialization` keep the deployment's own height, block and transaction.
 */
export function initializationRow({ receipt, initialization }, header, { source, chainId, directoryId, projectionOptions }) {
  return jsonSafe({ event: { type: 'frozen_receipt', receipt: encodeReceipt(receipt), projectionOptions, initialization },
    meta: { source, timeSource: 'block', chainId: chainId ?? null, observedAt: new Date(header.timestamp * 1000).toISOString(),
      blockHeight: header.height, blockHash: header.hash, txId: initialization.transaction, eventIndex: receipt.events[0].ordinal,
      eventId: receipt.id, contractKey: 'frozen', contractId: directoryId } })
}
