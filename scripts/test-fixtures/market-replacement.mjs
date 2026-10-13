import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { blake3 } from '@noble/hashes/blake3.js'
import { fromHex, hex, loadDataDriver, stringifyJson } from '@duskdomains/sdk'
import { deploymentContractId, initializationRow } from '../local-event-collector/deployment.mjs'
import { initializationHash } from '../../server/local-indexer/policy-initialization.mjs'
import { binding, directory, id, marketConfig, projectionOptions } from './frozen-events.mjs'

// The reviewed marketplace data driver (drivers.json pins its SHA-256): the canonical init archive
// encoder that the deploy tool also uses for init hashes.
export const marketDriver = await loadDataDriver(gunzipSync(readFileSync(new URL('./frozen/marketplace.wasm.gz', import.meta.url))))

/** A replacement marketplace deployed with real canonical init bytes; its ID derives as on chain. */
export function marketDeployment({ bind = binding, wasm = 'replacement marketplace wasm', deployNonce = 8n, owner = Array(96).fill(9) } = {}) {
  const args = { binding: bind }
  const archive = marketDriver.encodeInput('init', stringifyJson(args))
  const bytecode = new TextEncoder().encode(wasm)
  const market = deploymentContractId({ bytecode, deployNonce, owner: Uint8Array.from(owner) })
  return { market, args, archive, bytecode, owner, deployNonce, codeHash: hex(blake3(bytecode)), initHash: initializationHash(archive) }
}

/** Marketplace v1 initializes paused at 250 bps; `set_fee` and `set_pause` emit the whole config again. */
export function marketplaceConfig(bind = binding, overrides = {}) {
  return { ...marketConfig(), binding: bind, fee_bps: 250, new_orders_disabled: true, ...overrides }
}

function directoryAction(height, action, change, market = null) {
  const config = directory().config
  config.revision = config.registration.revision = BigInt(height)
  change(config)
  return [1, 'action_applied', { id: { operator_epoch: 1n, nonce: BigInt(height) }, action, config, admission: null, market }]
}

/** The directory effect of an executed SetMarketplace from absent to Listed: the market's record. */
export function setMarketplace(height, d, { codeHash = d.codeHash, initHash = d.initHash, marketVersion = 2n } = {}) {
  const market = { id: fromHex(d.market, 32), state: 'Listed', version: 1n, interface_version: 1,
    code_hash: fromHex(codeHash, 32), init_hash: fromHex(initHash, 32) }
  return directoryAction(height, { SetMarketplace: { expected_version: 0n, market: market.id, state: 'Listed', interface_version: 1,
    code_hash: market.code_hash, init_hash: market.init_hash } }, config => { config.market_version = marketVersion }, market)
}

/** SetPreferredMarketplace to `d`, which must be Listed. */
export function preferMarketplace(height, d) {
  return directoryAction(height, { SetPreferredMarketplace: { expected_version: 2n, market: fromHex(d.market, 32) } }, config => {
    config.market_version = 3n
    config.preferred_marketplace = fromHex(d.market, 32)
  })
}

export const marketDeployTx = hex(Array(32).fill(0x6d))
export const feeTx = hex(Array(32).fill(0x6e))
export const blockHash = height => height.toString(16).padStart(64, '0')

/** One of the market's own operations: begin, `market_configured`, end, under its runtime path. */
export function marketReceipt(height, d, config, origin, opSeq = 1n) {
  const path = [fromHex(d.market, 32)], at = BigInt(height)
  return { id: `${blockHash(height)}:${origin}`, height: at, success: true, events: [
    { emitter: d.market, topic: 'operation_begin', data: { op_seq: opSeq, height: at, call_path: path }, reverted: false, ordinal: 0 },
    { emitter: d.market, topic: 'market_configured', data: { version: 1, op_seq: opSeq, body: { config } }, reverted: false, ordinal: 1 },
    { emitter: d.market, topic: 'operation_end', data: { op_seq: opSeq, call_path: path }, reverted: false, ordinal: 2 },
  ] }
}

/** A journaled pre-admission configuration exactly as the collector writes it after admission. */
export function marketInitializationEntry(d, { deployedAt = 15, configuredAt = 16, journaledAt = 20, config = marketplaceConfig(d.args.binding, { fee_bps: 300 }),
  receipt = marketReceipt(configuredAt, d, config, feeTx, 2n), evidence = {} } = {}) {
  const initialization = { role: 'marketplace', contractId: d.market, transaction: marketDeployTx, blockHeight: deployedAt, blockHash: blockHash(deployedAt),
    codeHash: d.codeHash, initArchive: hex(d.archive), deployNonce: String(d.deployNonce), deploymentOwner: hex(d.owner),
    configTransaction: feeTx, configBlockHeight: configuredAt, configBlockHash: blockHash(configuredAt), ...evidence }
  return initializationRow({ receipt, initialization }, { height: journaledAt, hash: id(200), timestamp: 1791374400 + journaledAt },
    { source: 'rusk-finalized-archive', chainId: 'dusk:1', directoryId: projectionOptions.directoryId, projectionOptions })
}
