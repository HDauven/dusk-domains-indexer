import { expect, it } from 'vitest'
import { createProjectionState, projectReceipt, snapshotProjection } from '@duskdomains/sdk/projection'
import { stringifyJson, parseJson, hex } from '@duskdomains/sdk'
import { createReplayState, applyReplayEvent, finalizeReplayState, replayEventLog } from './event-log-store.mjs'
import { decodeReceipt } from './receipt-codec.mjs'
import { createEventLog, moveHistory, envelope, receipt, rootNode, childNode, prefixed, bytes, id,
  projectionOptions, rootName, childName, ref, records, recordEffects, registered, admission, vaultEvents, claimEvents, order, sample, endpoint } from '../../scripts/test-fixtures/frozen-events.mjs'
import { recordsDigest } from '@duskdomains/sdk/projection'
const now = '2026-10-07T12:00:00.000Z'
function replay(events, height) { const warnings = []; const state = replayEventLog(events, warnings, now, height); expect(warnings).toEqual([]); return state }

it('matches the SDK state after each receipt and keeps retained event payloads immutable', () => {
  const m = moveHistory(), entries = [...m.events, m.final]
  let sdk = createProjectionState(projectionOptions)
  const state = createReplayState(), warnings = [], original = JSON.stringify(entries)
  for (const entry of entries) {
    sdk = projectReceipt(sdk, decodeReceipt(entry.event.receipt))
    applyReplayEvent(state, entry, warnings)
    expect(state.projection).toEqual(sdk)
  }
  expect(warnings).toEqual([])
  expect(JSON.stringify(entries)).toBe(original)
})
it('publishes the whole moved tree only with the paired activation and keeps permanent forwards through cleanup', () => {
  const m = moveHistory()
  const preparing = replay(m.events)
  expect(preparing.namesByNode.get(rootNode)).toMatchObject({ homeShard: prefixed(4), generation: '7', moveStatus: { locked: true, stagedCount: 2 } })
  const moved = replay([...m.events, m.final])
  expect(moved.namesByNode.get(rootNode)).toMatchObject({ homeShard: prefixed(8), slotEpoch: '101', forwarding: [{ source: prefixed(4), destination: prefixed(8) }] })
  expect(moved.subnamesByNode.get(childNode).homeShard).toBe(prefixed(8))
  expect([...moved.reverseByEndpoint.values()][0]).toMatchObject({ homeShard: prefixed(8), mappingId: '50' })
  const cleanup = envelope(receipt(31, [[4, 'forwarded_rows_pruned', { root: m.root.key.root, move_id: m.ticket.id, names: [ref(m.root), ref(m.child)], remaining: 0 }]]))
  const after = replay([...m.events, m.final, cleanup])
  expect(after.forwards).toEqual(moved.forwards)
  expect(after.recordsByNode.get(rootNode)).toEqual(moved.recordsByNode.get(rootNode))
})
it.each(['stage', 'seal', 'activation'])('fails closed on incomplete %s history without a half move', kind => {
  const m = moveHistory(), entries = [...m.events, m.final]
  if (kind === 'stage') entries.splice(7, 1)
  if (kind === 'seal') entries.splice(9, 1)
  if (kind === 'activation') entries.at(-1).event.receipt.events.splice(3)
  const warnings = [], state = replayEventLog(entries, warnings, now)
  expect(warnings).toHaveLength(1)
  expect(state.namesByNode.size).toBe(0)
  expect(state.unavailable).toBe(true)
})
it('derives automatic unlock and distinguishes owner/idle cooldowns from expiry cleanup', () => {
  const m = moveHistory(), events = m.events.slice(0, 7)
  expect(replay(events, 379).namesByNode.get(rootNode).moveStatus.locked).toBe(true)
  expect(replay(events, 380).namesByNode.get(rootNode).moveStatus.locked).toBe(false)
  for (const [reason, at, applied] of [['Owner', 25, true], ['Idle', 380, true], ['Expired', 8660, false], ['LifecycleEnded', 1000, false]]) {
    const cancel = envelope(receipt(at, [[4, 'move_cancelled', { ticket: m.ticket, reason, cancelled_at: BigInt(at), cooldown_applied: applied }]]))
    const state = replay([...events, cancel], at)
    expect(state.namesByNode.get(rootNode).moveStatus).toMatchObject({ status: 'cancelled', cooldownApplied: applied })
    expect(state.namesByNode.get(rootNode).moveCooldowns.rootAvailableAt).toBe(applied ? at + 8640 : null)
  }
})
it('uses generations and inherited expiry without attributing renewals to the payer', () => {
  const n = rootName(), child = childName(), renewal = { root: ref(n), old_expiry: 1000n, expires_at: 3000n,
    old_grace_end: 2000n, grace_end: 4000n, inheritance_rule: 1, years: 1, payer: { kind: 'Contract', bytes: bytes(17) },
    fee_lux: '10000000000', referral_lux: '1000000000', schedule_version: 1n }
  const events = [...createEventLog(), envelope(receipt(16, [[4, 'root_renewed', renewal]]))]
  const state = replay(events)
  expect(state.subnamesByNode.get(childNode).expiresAtBlockHeight).toBe(3000)
  expect(state.namesByAuthority.has(prefixed(17))).toBe(false)
  const next = { ...n, incarnation: { generation: 8n, serial: 1n }, owner: bytes(18), records: null, expires_at: 6000n, grace_end: 7000n }
  const renewed = replay([...events, envelope(receipt(4000, [[4, 'subtree_removed', { target: ref(n), include_target: false, removed_count: 1, reason: 'Reregistered', actor: bytes(18) }], [4, 'root_registered', registered(next)]]))])
  expect(renewed.namesByNode.get(rootNode)).toMatchObject({ generation: '8', owner: prefixed(18) })
  expect(renewed.subnamesByNode.size).toBe(0)
  expect(renewed.reverseByEndpoint.size).toBe(0)
  expect(renewed.activityByNode.get(rootNode).some(e => e.eventType === 'root_renewed')).toBe(true)
})
it('filters reverted events, unclosed ancestors and duplicate receipts', () => {
  const entry = envelope(receipt(16, [[4, 'root_registered', registered({ ...rootName(), owner: bytes(20) })]]))
  entry.event.receipt.events[1].reverted = true
  const base = createEventLog()
  expect(replay([...base, entry]).namesByNode.get(rootNode).owner).toBe(prefixed(10))
  const unfinished = structuredClone(entry)
  unfinished.event.receipt.events[1].reverted = false
  unfinished.event.receipt.events.pop()
  expect(replay([...base, unfinished]).namesByNode.get(rootNode).owner).toBe(prefixed(10))
  const state = createReplayState(), warnings = []
  for (const e of [...base, ...base]) applyReplayEvent(state, e, warnings)
  expect(warnings).toEqual([])
  expect(Object.keys(state.projection.receipts)).toHaveLength(base.length)
})
it('discovers both roles mid-receipt and ignores effects before admission', () => {
  const commitment = hash => ({ commitment: { key: { actor: bytes(10), hash: bytes(hash) }, created_at: 16n } })
  const effects = [[8, 'commitment_created', commitment(22)], recordEffects('https://ignored.example', 4, 9)[0], admission('store', 8), admission('resolver', 9),
    [8, 'commitment_created', commitment(23)], ...recordEffects('https://new.example', 4, 9)]
  const state = replay([...createEventLog(), envelope(receipt(16, effects))])
  expect(state.commitmentsById.has(prefixed(22))).toBe(false)
  expect(state.commitmentsById.get(prefixed(23)).commitmentStore).toBe(prefixed(8))
  expect(state.namesByNode.get(rootNode).resolverId).toBe(prefixed(9))
  expect(state.recordsByNode.get(rootNode).at(-1).value).toBe('https://new.example')
  expect(state.recordHistoryByNodeKey.get(`${rootNode}:website`).map(r => r.value)).toEqual(['https://new.example'])
})
it('tracks custody delivery, the exact order and a sale without losing the name generation', () => {
  const n = rootName(), o = order(), custody = { nonce: 4n, incarnation: n.incarnation, custodian: bytes(6), origin_owner: n.owner, origin_manager: n.manager }
  const transferred = { ...n, owner: bytes(6), manager: bytes(6), custody }
  const listed = envelope(receipt(16, [[4, 'authorities_changed', { name: transferred, actor: n.owner, previous_owner: n.owner, previous_manager: n.manager, data_cleared: false, reason: 'Holder' }],
    [4, 'custody_started', { name: ref(n), custody, callback_data_hash: bytes(0) }], [6, 'order_changed', { order: o }]]))
  const state = replay([...createEventLog(), listed])
  expect(state.namesByNode.get(rootNode).custody).toMatchObject({ nonce: '4', originOwner: prefixed(10) })
  expect(state.marketplaceFixedSalesByNode.get(rootNode)).toMatchObject({ escrowed: true, orderId: '1', custodyNonce: '4' })
  const sold = envelope(receipt(17, [[4, 'custody_ended', { name: ref(n), nonce: 4n, reason: 'Sold' }],
    [4, 'authorities_changed', { name: { ...n, owner: bytes(14), manager: bytes(14) }, actor: bytes(6), previous_owner: bytes(6), previous_manager: bytes(6), data_cleared: false, reason: 'Holder' }],
    [6, 'order_closed', { order: o, reason: 'Sold' }]]))
  const after = replay([...createEventLog(), listed, sold])
  expect(after.namesByNode.get(rootNode)).toMatchObject({ owner: prefixed(14), generation: '7', custody: null })
  expect(after.marketplaceFixedSalesByNode.size).toBe(0)
})
it('uses vault receipts and claims for exact liabilities, including u64 values beyond Number', () => {
  const state = replay([...createEventLog(), vaultEvents(), claimEvents()])
  expect(state.treasuryState).toMatchObject({ protocolLux: '5000000000', liabilityLux: '1000000000', accountedLux: '6000000000' })
  expect(state.referralsByReferrer.get(prefixed(13))).toMatchObject({ claimedLux: '1000000000', claimableLux: '1000000000', accruedLux: '2000000000' })
  const fee = sample('FeeReceived'); fee.metadata.beneficiary = null; fee.liability_lux = '0'
  const huge = replay([...createEventLog(), envelope(receipt(18, [[2, 'fee_received', fee]]))])
  expect(huge.treasuryState.protocolLux).toBe('18446744073709551615')
  expect(huge.treasuryState.accountedLux).toBe('18446744073709551615')
})
it('preserves epoch/generation integers at u64 maximum and rejects lossy receipt data', () => {
  const n = { ...rootName(), incarnation: { generation: 18446744073709551615n, serial: 1n }, records: null }
  const entry = envelope(receipt(20, [[4, 'root_registered', registered(n)]]))
  expect(replay([...createEventLog(), entry]).namesByNode.get(rootNode).generation).toBe('18446744073709551615')
  const broken = structuredClone(entry); broken.event.receipt.events[1].data = JSON.parse(broken.event.receipt.events[1].data)
  const warnings = []; replayEventLog([...createEventLog(), broken], warnings, now)
  expect(warnings[0].message).toContain('lossless JSON')
})
it('rejects a legacy journal instead of treating old core events as frozen history', () => {
  const warnings = []; const state = replayEventLog([{ event: { type: 'name_registered' } }], warnings, now)
  expect(warnings[0].message).toContain('Legacy event journal')
  expect(state.namesByNode.size).toBe(0)
})

it('keeps selected policy identity and renewal terms when pre-admission initialization is unavailable', () => {
  const a = { ...sample('Admission'), id: bytes(19), admitted_at: 19n }
  const state = createReplayState(), warnings = []
  for (const e of createEventLog()) applyReplayEvent(state, e, warnings)
  const config = structuredClone(state.projection.directory)
  config.registration.policy = a.id; config.registration.policy_version = 2n
  config.renewal.version = 2n; config.renewal.annual_lux = Array(5).fill('5000000000')
  const entry = envelope(receipt(19, [[1, 'action_applied', {
    id: { operator_epoch: 1n, nonce: 19n }, action: { SetPolicy: { expected_version: 1n, admission: a } }, config, admission: a, market: null,
  }]]))
  applyReplayEvent(state, entry, warnings)
  const view = finalizeReplayState(state, now, 19)
  expect(warnings).toEqual([])
  expect(view.policy).toEqual({ contractId: prefixed(19), version: '2', config: null })
  expect(view.renewalSchedule).toMatchObject({ version: '2', annual_lux: Array(5).fill('5000000000') })
  expect(view.feeConfig).toMatchObject({ threeCharYearLux: null, registrationsPaused: true })
})

it('retains per-key clear history across replacement and custody identity clearing', () => {
  const first = envelope(receipt(15, recordEffects('https://old.example')))
  const removed = envelope(receipt(16, recordEffects()))
  const cleared = envelope(receipt(17, [[4, 'identity_cleared', { name: ref(rootName()), old_slot: rootName().records, old_primary: null, reason: 'CustodySale' }]]))
  const state = replay([...createEventLog(), first, removed, cleared])
  expect(state.recordsByNode.get(rootNode)).toEqual([])
  expect(state.recordHistoryByNodeKey.get(`${rootNode}:website`).map(r => r.action)).toEqual(['clear', 'set'])
  expect(state.recordHistoryByNodeKey.get(`${rootNode}:moonlight_address`)[0]).toMatchObject({ action: 'clear', value: null })
})

it('consumes new effects from the live state and skips duplicate IDs before decoding', () => {
  const state = createReplayState(), warnings = []
  for (const entry of createEventLog()) applyReplayEvent(state, entry, warnings)
  const live = state.projection, start = live.effects.length
  const entry = envelope(receipt(16, recordEffects('https://later.example')))
  applyReplayEvent(state, entry, warnings)
  expect(state.projection).toBe(live)
  expect(live.effects.length).toBe(start + 2)
  expect(Object.hasOwn(live.receipts, entry.meta.eventId)).toBe(true)
  expect(state.newestEventHeight).toBe(16)
  expect(finalizeReplayState(state, now).recordsByNode.get(rootNode).at(-1).value).toBe('https://later.example')

  const projected = snapshotProjection(live), published = structuredClone(finalizeReplayState(state, now))
  const duplicate = structuredClone(entry)
  duplicate.event.receipt.events[1].data = 'invalid duplicate payload'
  applyReplayEvent(state, duplicate, warnings)
  expect(warnings).toEqual([])
  expect(live).toEqual(projected)
  expect(finalizeReplayState(state, now)).toEqual(published)

  // A newly accepted receipt with no committed effects still advances the replay clock.
  const empty = envelope(receipt(17, []))
  applyReplayEvent(state, empty, warnings)
  expect(state.newestEventHeight).toBe(17)
  expect(Object.hasOwn(live.receipts, empty.meta.eventId)).toBe(true)
  expect(live.effects.length).toBe(start + 2)
  expect(warnings).toEqual([])
})

function objectReferences(value, found = new Set()) {
  if (!value || typeof value !== 'object' || found.has(value)) return found
  found.add(value)
  const children = value instanceof Map ? [...value].flat() : value instanceof Set ? [...value] : Object.values(value)
  for (const child of children) objectReferences(child, found)
  return found
}

it('keeps published views independent of live tables, nested rows, effects and indexes across receipts', () => {
  const m = moveHistory(), o = order()
  const entries = [...m.events, m.final, vaultEvents(31), claimEvents(32),
    envelope(receipt(33, [[6, 'order_changed', { order: o }],
      [6, 'refund_changed', { refund: { authority: bytes(14), amount_lux: '100' } }]])),
    envelope(receipt(34, [[6, 'order_changed', { order: { ...o, terms: { ...o.terms, amount_lux: '40000000000' } } }],
      [6, 'refund_changed', { refund: { authority: bytes(14), amount_lux: '50' } }]])),
    envelope(receipt(35, [[6, 'order_closed', { order: o, reason: 'Sold' }]])),
    envelope(receipt(36, recordEffects('https://moved.example', 8, 9, 101n))),
    envelope(receipt(37, [[8, 'root_renewed', { root: ref(m.root), old_expiry: 1000n, expires_at: 3000n,
      old_grace_end: 2000n, grace_end: 4000n, inheritance_rule: 1, years: 1, payer: { kind: 'Contract', bytes: bytes(10) },
      fee_lux: '10000000000', referral_lux: '1000000000', schedule_version: 1n }]])),
  ]
  const state = createReplayState(), warnings = [], published = []
  for (const entry of entries) {
    applyReplayEvent(state, entry, warnings)
    expect(warnings).toEqual([])
    for (const [view, snapshot] of published) expect(view).toEqual(snapshot)
    const view = finalizeReplayState(state, now)
    const owned = objectReferences(state.projection)
    expect([...objectReferences(view)].some(value => owned.has(value))).toBe(false)
    published.push([view, structuredClone(view)])
  }
  const last = published.at(-1)[0]
  expect(last.namesByNode.get(rootNode)).toMatchObject({ homeShard: prefixed(8), expiresAtBlockHeight: 3000 })
  expect(last.subnamesByNode.get(childNode).expiresAtBlockHeight).toBe(3000)
  expect(last.recordsByNode.get(rootNode).at(-1).value).toBe('https://moved.example')
  expect(last.treasuryState.accountedLux).toBe('6000000000')
})

it('preserves projection and published history when a receipt fails after partial application', () => {
  const m = moveHistory(), state = createReplayState(), warnings = []
  for (const entry of m.events) applyReplayEvent(state, entry, warnings)
  const live = state.projection, checkpoint = snapshotProjection(live)
  const view = finalizeReplayState(state, now), snapshot = structuredClone(view)
  const partial = structuredClone(m.final)
  partial.event.receipt.events.splice(3) // Activation mutates destination rows before the paired-move check fails.
  applyReplayEvent(state, partial, warnings)
  expect(warnings).toHaveLength(1)
  expect(state.projection).toBe(live)
  expect(live).toEqual(checkpoint)
  expect(Object.hasOwn(live.receipts, partial.meta.eventId)).toBe(false)
  expect(state.newestEventHeight).toBe(23)
  expect(view).toEqual(snapshot)
  expect(finalizeReplayState(state, now, 100)).toEqual(snapshot)
  applyReplayEvent(state, m.final, warnings)
  expect(live).toEqual(checkpoint)
  expect(warnings).toHaveLength(1)
})
