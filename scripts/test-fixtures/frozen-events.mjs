import { encodeReceipt } from '../../server/local-indexer/receipt-codec.mjs'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parseJson, wireValue, nameKey, launchPolicyConfig, hex, encodeBase58 } from '@duskdomains/sdk'
import { recordsDigest, moveManifestDigest } from '@duskdomains/sdk/projection'
import { jsonSafe } from '../../server/local-indexer/frozen-view.mjs'
const golden = parseJson(gunzipSync(readFileSync(new URL('./frozen/frozen-v1.json.gz', import.meta.url))).toString())
export const sample = type => wireValue(type, golden[type].json)
export const bytes = (n, length = 32) => Array(length).fill(n)
export const id = n => hex(bytes(n))
export const prefixed = n => `0x${id(n)}`
export const scope = { [id(1)]: 'directory', [id(2)]: 'vault', [id(3)]: 'policy', [id(4)]: 'store', [id(5)]: 'resolver', [id(6)]: 'marketplace' }
export const projectionOptions = { directoryId: id(1), contracts: scope }
export const binding = { directory: bytes(1), vault: bytes(2), network: 1 }
export const beneficiary = { kind: 'Contract', bytes: bytes(13) }
export const endpoint = bytes(12, 96)
export const address = encodeBase58(endpoint)
export const rootNode = `0x${hex(nameKey('aurora.dusk').node)}`
export const childNode = `0x${hex(nameKey('x.aurora.dusk').node)}`
export function makeName(spelling = 'aurora.dusk', serial = 1n) {
  return { key: nameKey(spelling), label: spelling.split('.')[0], incarnation: { generation: 7n, serial },
    owner: bytes(10), manager: bytes(11), expires_at: 1000n, grace_end: 2000n,
    referrer: beneficiary, subname: null, records: null, custody: null }
}
export const ref = n => ({ key: n.key, incarnation: n.incarnation })
export const counters = { generation: 7n, next_serial: 6n, next_epoch: 10n, next_custody: 4n, revision: 5n }
export function records(value) {
  return [{ key: 'moonlight_address', value: endpoint, ttl_seconds: 300n, updated_at: 11n },
    ...(value ? [{ key: 'website', value: [...new TextEncoder().encode(value)], ttl_seconds: 300n, updated_at: 11n }] : [])]
}
export function rootName(value) {
  return { ...makeName(), records: { resolver: bytes(5), epoch: 1n, count: records(value).length, digest: recordsDigest(records(value)) } }
}
export function childName() {
  return { ...makeName('x.aurora.dusk', 2n), subname: { parent: nameKey('aurora.dusk').node, depth: 1, expiry_policy: 'InheritsParent', created_at: 14n } }
}
export function registered(n) {
  return { ...sample('RootRegistered'), name: n, previous_generation: n.incarnation.generation - 1n,
    reason: 'Paid', payer: { kind: 'Contract', bytes: bytes(10) }, policy: bytes(3), policy_version: 1n,
    policy_config_version: 1n, fee_lux: '10000000000', premium_lux: '0', referral_lux: '2000000000' }
}
export function directory() {
  const d = sample('DirectoryInitialized'), config = d.config, p = launchPolicyConfig()
  config.binding = binding
  config.registration = { revision: 1n, policy: bytes(3), policy_version: 1n, operator: config.operator.principal,
    operator_paused: false, guardian_suspended: false, allocation_version: 1n, newest_store: bytes(4) }
  config.revision = config.operator_epoch = config.guardian_epoch = config.source_version = config.market_version = 1n
  config.proposal_delay = 17280n; config.guardian_delay = 60480n
  config.preferred_marketplace = bytes(6)
  config.renewal = { version: 1n, effective_at: 1n, annual_lux: p.annual_lux, referral_bps: 1000 }
  for (const [key, n, ordinal] of [['initial_store', 4, 0], ['initial_resolver', 5, 0], ['policy', 3, 0]])
    d.args[key] = { ...sample('Admission'), id: bytes(n), ordinal, admitted_at: 1n }
  d.args.initial_market = { ...sample('Market'), id: bytes(6), version: 1n }
  d.args.vault = bytes(2); d.args.operator_paused = false
  d.args.proposal_delay = config.proposal_delay; d.args.guardian_delay = config.guardian_delay
  d.args.renewal_annual_lux = p.annual_lux; d.args.renewal_referral_bps = 1000
  return d
}
export function marketConfig() {
  return { binding, fee_bps: 250, new_orders_disabled: false, next_order_id: 1n, unsettled_orders: 0n,
    refund_accounts: 0n, held_lux: '0', refundable_lux: '0' }
}
export function receipt(height, effects, identifier = `tx-${height}`) {
  height = BigInt(height)
  const events = []
  for (const [who, topic, body] of effects) {
    const op_seq = BigInt(events.length + 1), call_path = [bytes(who)], emitter = id(who)
    events.push({ emitter, topic: 'operation_begin', data: { op_seq, height, call_path }, ordinal: events.length },
      { emitter, topic, data: { version: 1, op_seq, body }, ordinal: events.length + 1 },
      { emitter, topic: 'operation_end', data: { op_seq, call_path }, ordinal: events.length + 2 })
  }
  return { id: identifier, height, success: true, events }
}
export function envelope(r) {
  return jsonSafe({ event: { type: 'frozen_receipt', receipt: encodeReceipt(r), projectionOptions },
    meta: { eventId: r.id, txId: r.id, blockHeight: Number(r.height), blockHash: id(200), chainId: 'dusk:1',
      source: 'rusk-finalized-archive', contractKey: 'frozen', contractId: id(1), observedAt: '2026-10-07T12:00:00.000Z' } })
}
export function bootstrap(height = 1) {
  return envelope(receipt(height, [
    [3, 'policy_initialized', { args: { binding, config: launchPolicyConfig() } }],
    [2, 'vault_initialized', { args: { binding, sources: [{ id: bytes(4), kind: 'Store', state: 'Listed' }] } }],
    [5, 'resolver_initialized', { args: { binding } }], [4, 'store_initialized', { args: { binding } }],
    [6, 'market_configured', { config: marketConfig() }], [1, 'directory_initialized', directory()],
  ]))
}
export function recordEffects(value, store = 4, resolver = 5, epoch = 1n) {
  const n = rootName(value), snapshot = { records: records(value), count: records(value).length, digest: recordsDigest(records(value)) }
  return [[resolver, 'resolver_slot_written', { slot: { registry: bytes(store), node: n.key.node, epoch }, snapshot }],
    [store, 'slot_changed', { name: ref(n), previous: null, reason: 'Mutation', current: { resolver: bytes(resolver), epoch, count: snapshot.count, digest: snapshot.digest } }]]
}
export function createEventLog() {
  const n = { ...rootName(), records: null }
  return [bootstrap(), envelope(receipt(10, [[4, 'root_registered', registered(n)], [4, 'root_counters_changed', { root: n.key.root, counters }]])),
    envelope(receipt(11, recordEffects())),
    envelope(receipt(12, [[4, 'primary_changed', { endpoint, previous: null, current: { endpoint, name: ref(n), mapping_id: 1n, updated_at: 12n }, reason: 'Set' }]])),
    envelope(receipt(14, [[4, 'subname_created', { name: childName(), actor: bytes(10) }]]))]
}
export function admission(role, who, height = 15) {
  const a = { ...sample('Admission'), id: bytes(who), ordinal: 1, admitted_at: BigInt(height) }, config = directory().config
  config.revision = config.registration.revision = BigInt(height)
  const action = role === 'store' ? { AddStore: { expected_allocation_version: 1n, admission: a } }
    : { AddResolver: { expected_count: 1, admission: a } }
  return [1, 'action_applied', { id: { operator_epoch: 1n, nonce: BigInt(height) }, action, config, admission: a, market: null }]
}
export function moveHistory() {
  const events = createEventLog(), root = rootName(), c = childName()
  const originalPrimary = { endpoint, name: ref(root), mapping_id: 1n, updated_at: 12n }
  const rows = [{ index: 0, name: root, primary: originalPrimary }, { index: 1, name: c, primary: null }]
  const ticket = { id: bytes(42), source: bytes(4), destination: bytes(8), root: ref(root), initiator: root.owner,
    source_revision: 5n, counters, row_count: 2, primary_count: 1, manifest: bytes(0), created_at: 20n, expires_at: 8660n }
  ticket.manifest = moveManifestDigest(ticket, rows)
  const status = { ticket, staged: Array(33).fill(0), staged_count: 0, staged_primaries: 0, last_progress_at: 20n,
    ready: false, prepared_counters: { ...counters, revision: 6n }, reserved_bytes: 4096n, activated: false, cancelled: false }
  events.push(envelope(receipt(15, [admission('store', 8), admission('resolver', 9)])))
  events.push(envelope(receipt(20, [[4, 'move_started', { ticket, lifecycle_deadline: 1000n }], [8, 'import_prepared', { status }]])))
  rows.forEach((original, index) => {
    const imported = { ...original.name, records: original.name.records ? { ...original.name.records, epoch: 101n, resolver: bytes(9) } : null }
    const effects = imported.records ? [[9, 'resolver_slot_written', { slot: { registry: bytes(8), node: imported.key.node, epoch: 101n },
      snapshot: { records: records(), count: 1, digest: imported.records.digest } }]] : []
    effects.push([8, 'import_row_staged', { id: ticket.id, index, original, imported,
      imported_primary: original.primary ? { ...original.primary, mapping_id: 50n } : null }],
    [4, 'move_progressed', { id: ticket.id, staged_count: index + 1, last_progress_at: BigInt(21 + index) }])
    events.push(envelope(receipt(21 + index, effects)))
  })
  const finalCounters = { ...counters, next_epoch: 102n, revision: 6n }
  events.push(envelope(receipt(23, [[8, 'import_ready', { id: ticket.id, manifest: ticket.manifest, row_count: 2, primary_count: 1, counters: finalCounters }]])))
  const final = envelope(receipt(30, [[8, 'root_imported', { ticket, counters: finalCounters, live: { revision: 5n, rows: [
    { expires_at: 1000n, grace_end: 2000n, expiry_policy: null, primary_mapping_id: 1n },
    { expires_at: 1000n, grace_end: 2000n, expiry_policy: 'InheritsParent', primary_mapping_id: 0n }] } }],
  [4, 'root_forwarded', { ticket, forward: { root: root.key.root, destination: bytes(8), destination_ordinal: 1,
    move_id: ticket.id, generation: 7n, completed_at: 30n } }]]))
  return { events, final, ticket, root, child: c }
}
export function vaultEvents(height = 16) {
  return envelope(receipt(height, [[2, 'beneficiary_reserved', { beneficiary, reserved_beneficiaries: 1 }],
    [2, 'fee_received', { ...sample('FeeReceived'), source: bytes(4), received_lux: '10000000000', protocol_lux: '8000000000',
      liability_lux: '2000000000', beneficiary_claimable_lux: '2000000000', metadata: { ...sample('FeeReceived').metadata,
        beneficiary, reason: 'Registration', name: ref(rootName()), referral_lux: '2000000000' } }]]))
}
export function claimEvents(height = 17) {
  return envelope(receipt(height, [[2, 'referral_claimed', { ...sample('ReferralClaimed'), beneficiary, amount_lux: '1000000000',
    remaining_lux: '1000000000', liability_lux: '1000000000' }],
  [2, 'protocol_claimed', { ...sample('ProtocolClaimed'), amount_lux: '3000000000', remaining_lux: '5000000000' }]]))
}
export function order(kind = 'Fixed', number = 1n, store = 4) {
  return { terms: { version: 1, directory: bytes(1), store: bytes(store), name: ref(rootName()), id: number, kind,
    amount_lux: '20000000000', fee_bps: 250, seller: bytes(10), seller_manager: bytes(11), seller_recipient: endpoint,
    buyer: kind === 'Offer' ? bytes(14) : null, buyer_manager: kind === 'Offer' ? bytes(14) : null,
    deadline: 500n, duration_blocks: kind === 'Auction' ? 360n : 0n, referral: null },
    nonce: 4n, status: 'Open', payer: null, highest: null, started_at: null, end: null, maximum_end: null, bid_count: 0 }
}
