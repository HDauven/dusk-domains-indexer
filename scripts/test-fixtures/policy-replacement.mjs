import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { blake3 } from '@noble/hashes/blake3.js'
import { fromHex, hex, launchPolicyConfig, loadDataDriver, parseJson, stringifyJson } from '@duskdomains/sdk'
import { deploymentContractId, initializationRow } from '../local-event-collector/deployment.mjs'
import { initializationHash } from '../../server/local-indexer/policy-initialization.mjs'
import { binding, directory, id, projectionOptions } from './frozen-events.mjs'

// The reviewed policy data driver (drivers.json pins its SHA-256): the canonical init archive
// encoder that the deploy tool also uses for init hashes.
export const policyDriver = await loadDataDriver(gunzipSync(readFileSync(new URL('./frozen/policy.wasm.gz', import.meta.url))))
// Recorded from a local Rusk 1.7.1 archive node: a real frozen policy deployment (see frozen/README.md).
export const recordedDeployment = parseJson(gunzipSync(readFileSync(new URL('./frozen/policy-deployment.json.gz', import.meta.url))).toString())

/** A fee change: every registration term differs from launch, renewal is not part of it. */
export function replacementConfig(overrides = {}) {
  return { ...launchPolicyConfig(), annual_lux: ['900000000000', '400000000000', '200000000000', '80000000000', '20000000000'],
    premium_start_lux: '2000000000000000', base_referral_bps: 1500, premium_referral_bps: 500,
    reserved: ['bridge', 'newreserved', 'wallet'], denied: ['spam'], ...overrides }
}

/** A replacement policy deployed with real canonical init bytes; its ID derives as on chain. */
export function policyDeployment({ config = replacementConfig(), bind = binding, wasm = 'replacement policy wasm', deployNonce = 7n,
  owner = Array(96).fill(9) } = {}) {
  const args = { binding: bind, config }
  const archive = policyDriver.encodeInput('init', stringifyJson(args))
  const bytecode = new TextEncoder().encode(wasm)
  const policy = deploymentContractId({ bytecode, deployNonce, owner: Uint8Array.from(owner) })
  return { policy, args, archive, bytecode, owner, deployNonce, codeHash: hex(blake3(bytecode)), initHash: initializationHash(archive) }
}

/** dusk-core Moonlight deployment bytes, tag 3 + Boreas format 2 (or legacy tag 1). */
export function deployTransactionHex(d, { chainId = binding.network, archive = d.archive, boreas = true, receiver = false, refund = false } = {}) {
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const vec = b => Buffer.concat([u64(b.length), Buffer.from(b)])
  // A receiver or refund address other than the sender is written after a 1 flag.
  const key = (present, fill) => present ? Buffer.concat([Buffer.from([1]), Buffer.alloc(96, fill)]) : Buffer.from([0])
  const payload = Buffer.concat([Buffer.from([chainId]), Buffer.alloc(96, 5), key(receiver, 8), u64(0), u64(0), u64(500_000_000), u64(2000),
    key(refund, 9), u64(1), Buffer.from([2]), Buffer.from(blake3(d.bytecode)), vec(d.bytecode), vec(d.owner), Buffer.from([1]), vec(archive),
    u64(d.deployNonce)])
  return Buffer.concat([Buffer.from(boreas ? [3, 2] : [1]), u64(payload.length), payload, Buffer.alloc(48, 6)]).toString('hex')
}

/** The directory effect of an executed SetPolicy: the effective admission at its execution height. */
export function setPolicy(height, d, { initHash = d.initHash, codeHash = d.codeHash, policyVersion = 2n } = {}) {
  const config = directory().config, policy = fromHex(d.policy, 32)
  config.revision = config.registration.revision = BigInt(height)
  config.registration.policy = policy
  config.registration.policy_version = policyVersion
  const admission = { id: policy, interface_version: 1, code_hash: fromHex(codeHash, 32), init_hash: fromHex(initHash, 32), ordinal: 0,
    admitted_at: BigInt(height), accepts_moves: false, retiring: false, governance_version: 1n }
  return [1, 'action_applied', { id: { operator_epoch: 1n, nonce: BigInt(height) },
    action: { SetPolicy: { expected_version: policyVersion - 1n, admission: { ...admission, admitted_at: 0n } } },
    config, admission, market: null }]
}

export const deployTx = hex(Array(32).fill(0x7d))
export const blockHash = height => height.toString(16).padStart(64, '0')

/** The policy's own deployment journal: begin, initialization, end, under its runtime path. */
export function deploymentReceipt(height, d, args = d.args, origin = deployTx) {
  const path = [fromHex(d.policy, 32)], at = BigInt(height)
  return { id: `${blockHash(height)}:${origin}`, height: at, success: true, events: [
    { emitter: d.policy, topic: 'operation_begin', data: { op_seq: 1n, height: at, call_path: path }, reverted: false, ordinal: 0 },
    { emitter: d.policy, topic: 'policy_initialized', data: { version: 1, op_seq: 1n, body: { args } }, reverted: false, ordinal: 1 },
    { emitter: d.policy, topic: 'operation_end', data: { op_seq: 1n, call_path: path }, reverted: false, ordinal: 2 },
  ] }
}

/** A journaled initialization exactly as the collector writes it after admission. */
export function initializationEntry(d, { deployedAt = 19, journaledAt = 20, receipt = deploymentReceipt(deployedAt, d), evidence = {} } = {}) {
  const initialization = { role: 'policy', contractId: d.policy, transaction: deployTx, blockHeight: deployedAt, blockHash: blockHash(deployedAt),
    codeHash: d.codeHash, initArchive: hex(d.archive), deployNonce: String(d.deployNonce), deploymentOwner: hex(d.owner), ...evidence }
  return initializationRow({ receipt, initialization }, { height: journaledAt, hash: id(200), timestamp: 1791374400 + journaledAt },
    { source: 'rusk-finalized-archive', chainId: 'dusk:1', directoryId: projectionOptions.directoryId, projectionOptions })
}
