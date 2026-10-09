import { publicationReady } from './committed-publication.mjs'
import { decodeReceipt } from './receipt-codec.mjs'
import assert from 'node:assert/strict'
import { hex, contractId, encodeBase58, stringifyJson, authority } from '@duskdomains/sdk'
import { createProjectionState, projectReceipt, slotStateKey, nameStateKey, effectiveMoveLock, moveLockEndsAt, assertRecordsDigest } from '@duskdomains/sdk/projection'
import { indexNamesByAuthority } from './name-authority-index.mjs'
import { recordIndexKey, commitmentKey, marketplaceOfferKey, emptyMarketplaceConfig, emptyTreasuryState, appendRecordHistory } from './view-utils.mjs'
import { DEFAULT_FEE_CONFIG } from './constants.mjs'

const h = v => `0x${typeof v === 'string' ? v.replace(/^0x/, '') : hex(v)}`
const integer = v => v == null ? null : BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v)
export const jsonSafe = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v))
const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value) }
// Ingest in receipt order; copy into newest-first order only at publication.
const historyView = map => new Map([...map].map(([key, rows]) => [key, rows.toReversed()]))

export function createReplayState() {
  return { projection: null, options: null, appliedCount: 0, newestEventHeight: null, blocked: false, lastCompleteView: null,
    activityByNode: new Map(), recordHistoryByNode: new Map(), recordHistoryByNodeKey: new Map(),
    slotRecords: new Map(), registrationByNode: new Map(), timestamps: new Map(), treasuryEvents: [], referralEvents: new Map() }
}

export function applyReplayEvent(state, entry, warnings) {
  const index = ++state.appliedCount
  if (state.blocked) return
  try {
    const { event, meta = {} } = entry
    assert.equal(event?.type, 'frozen_receipt', 'Legacy event journal: rebuild from the frozen deployment first block')
    const r = event.receipt
    assert(r && typeof r.id === 'string' && r.success === true && Array.isArray(r.events), 'Invalid receipt envelope')
    assert.equal(String(r.height), String(meta.blockHeight), 'Receipt/metadata height mismatch')
    assert.equal(r.id, meta.eventId, 'Receipt/metadata identity mismatch')
    if (!state.projection) {
      state.options = JSON.stringify(event.projectionOptions)
      // Consume the projector's accepted effects, including same-receipt admissions.
      // There is no public drain API: this log grows for the lifetime of the replay.
      state.projection = createProjectionState({ ...event.projectionOptions, retainEffects: true })
    }
    assert.equal(JSON.stringify(event.projectionOptions), state.options, 'Deployment scope changed inside journal')
    const projection = state.projection
    const alreadyApplied = Object.hasOwn(projection.receipts, r.id)
    const effectsStart = projection.effects.length
    if (alreadyApplied) return
    projectReceipt(projection, decodeReceipt(r))
    state.newestEventHeight = meta.blockHeight
    const effects = projection.effects.slice(effectsStart), controllers = new Map(), affected = new Map()
    const operation = e => `${e.emitter}:${e.operationOrdinal}:${e.data.op_seq}`
    for (const e of effects) {
      const key = operation(e)
      if (e.topic === 'controller_used') controllers.set(key, e)
      const node = bodyNode(e.data.body)
      if (node) {
        if (!affected.has(key)) affected.set(key, new Set())
        affected.get(key).add(h(node))
      }
    }
    for (const e of effects) {
      const key = operation(e), controller = controllers.get(key)?.data.body
      if (e.topic === 'controller_used') {
        for (const node of affected.get(key) ?? []) retainHistory(state, e, meta, controller, node)
      } else retainHistory(state, e, meta, controller)
    }
  } catch (error) {
    // A missing stage/receipt makes every later answer suspect. Keep the last complete state.
    state.blocked = true
    warnings.push({ code: 'invalid_event_log_event', index, type: entry?.event?.type, message: error.message })
  }
}

function bodyNode(b) {
  return b.name?.key?.node ?? b.name?.node ?? b.root?.key?.node ?? (Array.isArray(b.root) ? b.root : null)
    ?? b.order?.terms?.name?.key?.node ?? b.slot?.node ?? b.current?.name?.key?.node ?? b.previous?.name?.key?.node
    ?? b.ticket?.root?.key?.node ?? b.forward?.root ?? b.target?.key?.node
}
function retainHistory(state, e, meta, controller, affectedNode) {
  const b = e.data.body, nodeBytes = bodyNode(b), node = affectedNode ?? (nodeBytes ? h(nodeBytes) : null)
  const base = { id: `${meta.eventId}:${e.ordinal}`, eventType: e.topic, node,
    contractId: h(e.emitter), timestamp: meta.observedAt ?? null, blockHeight: integer(e.height),
    txId: meta.txId ?? null, actor: b.actor ? h(b.actor) : null, eventIndex: e.ordinal, data: jsonSafe(b),
    ...(controller ? { via: h(controller.via), principal: jsonSafe(controller.principal), scope: controller.scope } : {}) }
  if (node) {
    push(state.activityByNode, node, base)
    state.timestamps.set(node, meta.observedAt ?? null)
  }
  if (e.topic === 'root_registered') state.registrationByNode.set(node, { reason: b.reason, premium_lux: b.premium_lux })
  if (e.topic === 'resolver_slot_written') {
    const key = slotStateKey(e.emitter, b.slot), previous = state.slotRecords.get(key) ?? []
    const current = new Map(b.snapshot.records.map(r => [r.key, r]))
    const append = record => appendRecordHistory({ ...state, node, entry: {
      ...base, ...record, resolverId: h(e.emitter), homeShard: h(b.slot.registry), slotEpoch: String(b.slot.epoch),
    } })
    for (const record of b.snapshot.records) append({ ...recordView(record, meta.observedAt), action: 'set' })
    for (const record of previous) if (!current.has(record.key)) append({ key: record.key, value: null, action: 'clear' })
    state.slotRecords.set(key, b.snapshot.records.map(r => ({ key: r.key })))
  }
  if (e.topic === 'identity_cleared' && b.old_slot) {
    const key = slotStateKey(contractId(b.old_slot.resolver), { registry: Array.from(Buffer.from(e.emitter, 'hex')), node: b.name.key.node, epoch: b.old_slot.epoch })
    for (const r of state.slotRecords.get(key) ?? []) appendRecordHistory({ ...state, node, entry: { ...base, key: r.key, value: null, action: 'clear' } })
  }
  if (e.topic === 'resolver_slot_pruned' || e.topic === 'identity_cleared' || e.topic === 'slot_changed') {
    appendRecordHistory({ ...state, node, entry: { ...base, key: '*', action: e.topic, value: null } })
  }
  if (['fee_received', 'protocol_claimed', 'referral_claimed'].includes(e.topic)) {
    state.treasuryEvents.push(base)
    const principal = b.metadata?.beneficiary ?? b.beneficiary
    if (principal) push(state.referralEvents, principalId(principal), base)
  }
}
function principalId(p) { return `${p.kind}:${hex(p.bytes)}` }
function recordView(r, timestamp = null) {
  let value, encoding = 'utf8'
  if (r.key === 'moonlight_address') { value = encodeBase58(r.value); encoding = 'base58' }
  else if (r.key === 'dusk_contract') { value = h(r.value); encoding = 'hex' }
  else { try { value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(r.value)) }
    catch { value = h(r.value); encoding = 'hex' } }
  return { key: r.key, value, valueBytes: [...r.value], encoding, visibility: 'public',
    ttlSeconds: integer(r.ttl_seconds), updatedAt: timestamp, updatedAtBlockHeight: integer(r.updated_at) }
}
function custodyView(c) {
  return c ? { nonce: String(c.nonce), generation: String(c.incarnation.generation), serial: String(c.incarnation.serial),
    custodian: h(c.custodian), originOwner: h(c.origin_owner), originManager: h(c.origin_manager) } : null
}
function forwardView(f, source) {
  return { source: h(source), root: h(f.root), destination: h(f.destination), destinationOrdinal: f.destination_ordinal,
    moveId: h(f.move_id), generation: String(f.generation), completedAtBlockHeight: integer(f.completed_at) }
}
export function emptyFrozenView() {
  return { namesByAuthority: new Map(), namesByNode: new Map(), namesByCanonical: new Map(), lifecyclesByCanonical: new Map(),
    subnamesByNode: new Map(), subnamesByParent: new Map(), subnamesByCanonical: new Map(),
    recordsByNode: new Map(), recordsByNodeKey: new Map(), reverseByEndpoint: new Map(), rawPrimaries: [],
    controllers: [], controllerVersion: '1',
    controllersByNode: new Map(), commitmentsById: new Map(), commitmentsByKey: new Map(),
    marketplaceFixedSalesByNode: new Map(), marketplaceAuctionsByNode: new Map(), marketplaceOffersByKey: new Map(),
    marketplaceRefundsByAuthority: new Map(), referralsByReferrer: new Map(),
    activityByNode: new Map(), recordHistoryByNode: new Map(), recordHistoryByNodeKey: new Map(),
    marketplaceConfig: emptyMarketplaceConfig(), treasuryState: emptyTreasuryState(), feeConfig: { ...DEFAULT_FEE_CONFIG },
    poolState: { registrationsPaused: true }, referralRewardsSupported: false,
    nextLifecycleBoundary: null, nextLifecycleDateBoundary: null, policy: null, renewalSchedule: null,
    projectionBlockHeight: null, directory: null, admissions: {}, forwards: [], moves: [], frozen: true }
}

export function finalizeReplayState(state, now, chainHeight = null, warnings = []) {
  const clock = chainHeight ?? state.newestEventHeight ?? 0
  if (!publicationReady(state, clock, warnings)) {
    if (state.lastCompleteView) return state.lastCompleteView
    // A cold reconstruction has no publication to retain. Withhold the prefix: its
    // receipt height cannot establish the current finalized lifecycle or identity.
    return { ...emptyFrozenView(), unavailable: true }
  }
  const s = state.projection
  const height = BigInt(clock)
  const view = { ...emptyFrozenView(), projectionBlockHeight: integer(height),
    activityByNode: historyView(state.activityByNode), recordHistoryByNode: historyView(state.recordHistoryByNode),
    recordHistoryByNodeKey: historyView(state.recordHistoryByNodeKey) }

  if (!s) { view.namesByAuthority = new Map(); state.lastCompleteView = view; return view }
  const boundary = n => { if (n > height && n <= BigInt(Number.MAX_SAFE_INTEGER)) view.nextLifecycleBoundary = Math.min(view.nextLifecycleBoundary ?? Infinity, Number(n)) }
  const rows = Object.entries(s.names)
  // Group once. Rows shared inside this publication are independent of SDK-owned state.
  const forwardsByRoot = new Map(), latestMoveByHomeRoot = new Map()
  for (const [key, forward] of Object.entries(s.forwards)) {
    const row = forwardView(forward, key.slice(0, 64))
    view.forwards.push(row)
    push(forwardsByRoot, row.root, row)
  }
  for (const [key, move] of Object.entries(s.moves)) {
    const store = key.slice(0, 64), root = hex(move.ticket.root.key.root)
    const row = moveView(move, store, height)
    view.moves.push(row)
    const current = { move, row }
    latestMoveByHomeRoot.set(`${store}:${root}`, current)
    if (move.forwarded) latestMoveByHomeRoot.set(`${contractId(move.ticket.destination)}:${root}`, current)
  }
  const spellings = new Map()
  const spelling = (store, n, seen = new Set()) => {
    const key = nameStateKey(store, n.key)
    if (spellings.has(key)) return spellings.get(key)
    assert(!seen.has(key), 'Cyclic name ancestry'); seen.add(key)
    let canonical = `${n.label}.dusk`
    if (n.subname) {
      const parent = s.names[`${store}:${hex(n.key.root)}:${hex(n.subname.parent)}`]
      const parentName = parent ? spelling(store, parent, seen) : null
      canonical = parentName ? `${n.label}.${parentName}` : null
    }
    spellings.set(key, canonical)
    return canonical
  }
  const resolverByName = new Map()
  const resolverFor = (store, n) => {
    const key = nameStateKey(store, n.key)
    if (resolverByName.has(key)) return resolverByName.get(key)
    const records = n.records ? s.slots[slotStateKey(contractId(n.records.resolver), {
      registry: Array.from(Buffer.from(store, 'hex')), node: n.key.node, epoch: n.records.epoch,
    })]?.records : []
    let health = n.records && records ? 'ok' : 'missing'
    if (health === 'ok') {
      try { assertRecordsDigest(records, n.records.count, n.records.digest) }
      catch { health = 'invalid' }
    }
    const endpoints = new Set((records ?? []).filter(r => r.key === 'moonlight_address').map(r => hex(r.value)))
    const result = { records, health, endpoints }
    resolverByName.set(key, result)
    return result
  }
  for (const [key, n] of rows) {
    const store = key.slice(0, 64), node = h(n.key.node), root = h(n.key.root)
    const liveRoot = s.names[`${store}:${hex(n.key.root)}:${hex(n.key.root)}`]
    if (n.subname && (!liveRoot || n.incarnation.generation !== liveRoot.incarnation.generation)) continue
    const canonicalName = spelling(store, n)
    if (!canonicalName) continue
    const latest = state.activityByNode.get(node)?.at(-1)
    const forwards = forwardsByRoot.get(root) ?? []
    const current = latestMoveByHomeRoot.get(`${store}:${hex(n.key.root)}`)
    const currentMove = current?.move
    const ready = currentMove ? s.imports[`${contractId(currentMove.ticket.destination)}:${hex(currentMove.ticket.id)}`]?.ready != null : false
    const rootCancelled = s.rootCooldowns[`${store}:${hex(n.key.root)}`]
    const initiatorCancelled = s.initiatorCooldowns[`${store}:${hex(n.owner)}`]
    const lifecycle = { node, root, canonicalName, owner: h(n.owner), manager: h(n.manager),
      resolverId: n.records ? h(n.records.resolver) : null, homeShard: h(store), forwarding: forwards,
      generation: String(n.incarnation.generation), serial: String(n.incarnation.serial), custody: custodyView(n.custody),
      slotEpoch: n.records ? String(n.records.epoch) : null, nameRef: jsonSafe({ key: n.key, incarnation: n.incarnation }),
      referrer: jsonSafe(n.referrer), expiresAt: null, graceEndsAt: null,
      expiresAtBlockHeight: integer(n.expires_at), graceEndsAtBlockHeight: integer(n.grace_end),
      status: height < n.expires_at ? 'active' : height < n.grace_end && !n.subname ? 'grace' : 'released',
      lastEventType: latest?.eventType ?? null, updatedAt: state.timestamps.get(node) ?? null,
      issuedAsReserved: state.registrationByNode.get(root)?.reason === 'Reserved',
      registrationPremiumLux: state.registrationByNode.get(root)?.premium_lux ?? '0',
      moveStatus: currentMove ? { ...current.row, ready } : null,
      moveCooldowns: { rootCancelledAt: integer(rootCancelled), rootAvailableAt: integer(rootCancelled == null ? null : rootCancelled + 8640n),
        initiator: h(n.owner), initiatorCancelledAt: integer(initiatorCancelled), initiatorAvailableAt: integer(initiatorCancelled == null ? null : initiatorCancelled + 8640n) },
    }
    boundary(n.expires_at); boundary(n.grace_end)
    if (currentMove) boundary(moveLockEndsAt(currentMove))
    const { records, health: resolverHealth } = resolverFor(store, n)
    lifecycle.resolverHealth = resolverHealth
    const visibleRecords = (records ?? []).map(r => recordView(r, state.timestamps.get(node)))
    // Raw records remain available through expiry; resolver validation separately checks active life.
    view.recordsByNode.set(node, visibleRecords)
    for (const record of visibleRecords) view.recordsByNodeKey.set(recordIndexKey(node, record.key), record)
    view.controllersByNode.set(node, new Set([lifecycle.owner, lifecycle.manager]))
    if (n.subname) {
      const sub = { ...lifecycle, name: canonicalName, label: n.label, parentNode: h(n.subname.parent),
        parentName: canonicalName.split('.').slice(1).join('.'), resolver: lifecycle.resolverId,
        expiryPolicy: n.subname.expiry_policy === 'InheritsParent' ? 'inherits_parent' : 'fixed_before_parent',
        createdAt: null, createdAtBlockHeight: integer(n.subname.created_at), status: height < n.expires_at ? 'active' : 'expired' }
      view.subnamesByNode.set(node, sub); view.subnamesByCanonical.set(canonicalName, sub); push(view.subnamesByParent, sub.parentNode, sub)
    } else {
      view.namesByNode.set(node, lifecycle); view.lifecyclesByCanonical.set(canonicalName, lifecycle)
      if (height < n.grace_end) view.namesByCanonical.set(canonicalName, { ...lifecycle, lifecycle, records: visibleRecords,
        resolverHealth, activity: view.activityByNode.get(node) ?? [] })
    }
  }
  for (const [key, p] of Object.entries(s.primaries)) {
    const store = key.slice(0, 64), node = h(p.name.key.node), row = view.namesByNode.get(node) ?? view.subnamesByNode.get(node)
    const raw = { endpoint: { type: 'moonlight_address', value: encodeBase58(p.endpoint) }, node,
      homeShard: h(store), mappingId: String(p.mapping_id), primaryName: row?.canonicalName ?? null, nameRef: jsonSafe(p.name) }
    view.rawPrimaries.push(raw)
    // Same verification as SDK projectedPrimary, using direct name/slot lookups and a
    // publication-wide uniqueness map instead of rescanning all primaries per endpoint.
    const name = s.names[nameStateKey(store, p.name.key)]
    if (!name || name.incarnation.generation !== p.name.incarnation.generation
      || name.incarnation.serial !== p.name.incarnation.serial || height >= name.expires_at || !name.records) continue
    const resolver = resolverFor(store, name)
    assert(resolver.records, 'Incomplete event history: primary resolver history')
    assert.equal(resolver.health, 'ok', 'Invalid primary records digest')
    if (!resolver.endpoints.has(hex(p.endpoint))) continue
    const endpointKey = `moonlight_address:${raw.endpoint.value}`
    assert(!view.reverseByEndpoint.has(endpointKey), 'Incomplete event history: pool primary uniqueness')
    view.reverseByEndpoint.set(endpointKey, { ...raw, verified: true })
  }
  for (const [key, c] of Object.entries(s.commitments)) {
    const row = { commitment: h(c.key.hash), controller: h(c.key.actor), commitmentStore: h(key.slice(0, 64)), createdAtBlockHeight: integer(c.created_at) }
    if (height > c.created_at + 8640n) continue
    boundary(c.created_at + 8641n)
    view.commitmentsById.set(row.commitment, row); view.commitmentsByKey.set(commitmentKey(row.controller, row.commitment), row)
  }
  view.controllerVersion = String(s.controllerVersion)
  view.controllers = Object.values(s.controllers).map(({ controller: c, admissionVersion }) => ({
    contractId: h(c.contract), scopes: c.scopes, suspended: c.suspended,
    admittedAtBlockHeight: integer(c.admitted_at), admissionVersion: String(admissionVersion),
  }))
  view.directory = jsonSafe(s.directory)
  view.admissions = jsonSafe(s.admissions)
  const config = s.directory, policy = config ? s.policies[contractId(config.registration.policy)]?.config : null
  view.policy = config ? { contractId: h(config.registration.policy), version: String(config.registration.policy_version), config: jsonSafe(policy ?? null) } : null
  view.renewalSchedule = config ? jsonSafe(config.renewal) : null
  view.poolState.registrationsPaused = !config || config.registration.operator_paused || config.registration.guardian_suspended || !policy?.registration_open
  view.feeConfig = { directory: view.directory, admissions: view.admissions, threeCharYearLux: policy?.annual_lux[2] ?? null, fourCharYearLux: policy?.annual_lux[3] ?? null,
    fivePlusYearLux: policy?.annual_lux[4] ?? null, premiumStartLux: policy?.premium_start_lux ?? '0',
    policy: view.policy, renewalSchedule: view.renewalSchedule, registrationsPaused: view.poolState.registrationsPaused, referralRewardBps: policy?.base_referral_bps ?? null,
    renewalReferralRewardBps: config?.renewal.referral_bps ?? null, premiumReferralRewardBps: policy?.premium_referral_bps ?? null, version: view.policy?.version ?? null }
  vaultView(view, state)
  marketView(view, s)
  view.namesByAuthority = indexNamesByAuthority(view.namesByCanonical, view.controllersByNode)
  state.lastCompleteView = view
  return view
}
function moveView(m, store, height) {
  return { homeShard: h(store), moveId: h(m.ticket.id), destination: h(m.ticket.destination), root: h(m.ticket.root.key.root),
    status: m.forwarded ? 'forwarded' : m.cancelled ? 'cancelled' : effectiveMoveLock(m, height) ? 'preparing' : 'unlocked',
    locked: effectiveMoveLock(m, height), lockEndsAtBlockHeight: integer(moveLockEndsAt(m)),
    stagedCount: m.stagedCount, lastProgressAtBlockHeight: integer(m.lastProgressAt), lifecycleDeadline: integer(m.lifecycleDeadline),
    cooldownApplied: m.cancelled?.cooldown_applied ?? false, cancellationReason: m.cancelled?.reason ?? null,
    ticket: jsonSafe(m.ticket), forward: m.forwarded ? forwardView(m.forwarded, store) : null }
}
function vaultView(view, state) {
  const s = state.projection
  view.referralRewardsSupported = Object.entries(s.scope).some(([id, role]) => role === 'vault' && s.initializations[id])
  const fees = state.treasuryEvents.filter(e => e.eventType === 'fee_received')
  const sum = (rows, amount) => rows.reduce((total, e) => total + BigInt(amount(e)), 0n).toString()
  const registrations = s.effects.filter(e => e.topic === 'root_registered')
  const registrationsByReferrer = new Map()
  let referralCount = 0
  for (const event of registrations) {
    const referrer = event.data.body.name.referrer
    if (!referrer) continue
    const key = principalId(referrer)
    registrationsByReferrer.set(key, (registrationsByReferrer.get(key) ?? 0) + 1)
    referralCount++
  }
  const operator = s.directory?.operator
  const lastFee = fees.at(-1)
  const claimRow = e => ({ ...e, amountLux: e.data.amount_lux, remainingLux: e.data.remaining_lux })
  view.treasuryState = { initialized: view.referralRewardsSupported, source: 'vault',
    protocolAccruedLux: s.vault.protocolLux, referralLiabilityLux: s.vault.liabilityLux,
    ...jsonSafe(s.vault), actualLux: null, surplusLux: null, events: state.treasuryEvents.slice(-12).reverse(),
    operator: jsonSafe(operator?.principal ?? null), operatorRecipient: operator ? encodeBase58(operator.recipient) : null,
    operatorAuthority: operator ? h(authority(operator.principal)) : null,
    sources: jsonSafe(s.sources), allowedFeeSources: Object.values(s.sources).filter(source => source.state === 'Listed').map(source => h(source.id)),
    availableLux: s.vault.protocolLux, referralClaimableLux: s.vault.liabilityLux,
    totalReceivedLux: sum(fees, e => e.data.received_lux),
    registrationReceivedLux: sum(fees.filter(e => e.data.metadata.reason === 'Registration'), e => e.data.received_lux),
    renewalReceivedLux: sum(fees.filter(e => e.data.metadata.reason === 'Renewal'), e => e.data.received_lux),
    otherReceivedLux: sum(fees.filter(e => e.data.metadata.reason === 'Marketplace'), e => e.data.received_lux),
    premiumReceivedLux: sum(registrations, e => e.data.body.premium_lux), premiumAccountingError: null,
    referralClaimedLux: sum(state.treasuryEvents.filter(e => e.eventType === 'referral_claimed'), e => e.data.amount_lux),
    referralCount,
    lastFeeSourceContract: lastFee ? h(lastFee.data.source) : null,
    lastFeeReason: lastFee ? lastFee.data.metadata.reason === 'Marketplace' ? 'other' : lastFee.data.metadata.reason.toLowerCase() : null,
    lastFeeNode: lastFee ? h(lastFee.data.metadata.name.key.node) : null,
    lastEventType: state.treasuryEvents.at(-1)?.eventType ?? null,
    claims: state.treasuryEvents.filter(e => e.eventType === 'protocol_claimed').slice(-12).reverse().map(claimRow),
  }
  for (const [key, r] of Object.entries(s.referrals)) {
    const events = state.referralEvents.get(key) ?? []
    const claimed = events.filter(e => e.eventType === 'referral_claimed').reduce((sum, e) => sum + BigInt(e.data.amount_lux), 0n)
    const recent = events.slice(-12).reverse()
    const row = { supported: true, referrer: key, beneficiary: jsonSafe(r.beneficiary),
      claimableLux: r.claimable_lux, claimedLux: String(claimed), accruedLux: String(BigInt(r.claimable_lux) + claimed),
      referralCount: registrationsByReferrer.get(key) ?? 0,
      events: recent, recentActivity: recent.map(e => ({ ...e,
        amountLux: e.eventType === 'fee_received' ? e.data.metadata.referral_lux : e.data.amount_lux,
        counterparty: e.data.metadata?.payer ?? null })) }
    view.referralsByReferrer.set(key, row)
    if (r.beneficiary.kind === 'Moonlight') view.referralsByReferrer.set(encodeBase58(r.beneficiary.bytes), row)
    if (r.beneficiary.kind === 'Contract') view.referralsByReferrer.set(h(r.beneficiary.bytes), row)
  }
}
function marketView(view, s) {
  const selected = s.directory ? (s.directory.preferred_marketplace ? contractId(s.directory.preferred_marketplace) : null) : Object.keys(s.marketConfigs)[0]
  const config = s.marketConfigs[selected]
  const markets = jsonSafe(s.markets)
  view.marketplaceConfig = { initialized: Boolean(config), marketplaceContractId: selected ? h(selected) : null,
    tradingPaused: config?.new_orders_disabled ?? true, feeBps: config?.fee_bps ?? 250, orderApiVersion: 1,
    config: jsonSafe(config ?? null), markets }
  view.marketplaceConfigs = Object.fromEntries(Object.entries(s.marketConfigs).map(([id, c]) => [h(id), { initialized: true, marketplaceContractId: h(id), tradingPaused: c.new_orders_disabled, feeBps: c.fee_bps, orderApiVersion: 1, config: jsonSafe(c), markets }]))
  for (const [key, order] of Object.entries(s.orders)) {
    const market = key.slice(0, 64), t = order.terms, node = h(t.name.key.node)
    const lifecycle = view.namesByNode.get(node)
    const row = { node, name: lifecycle?.canonicalName ?? null, marketplaceContractId: h(market), homeShard: h(t.store),
      orderId: String(t.id), saleId: String(t.id), auctionId: String(t.id), kind: t.kind, status: order.status,
      sellerAuthority: h(t.seller), buyerAuthority: t.buyer ? h(t.buyer) : null, priceLux: t.amount_lux,
      reservePriceLux: t.amount_lux, amountLux: t.amount_lux, feeBps: t.fee_bps,
      expiresAtBlockHeight: integer(t.deadline), startDeadlineBlockHeight: integer(t.deadline), durationBlocks: integer(t.duration_blocks),
      startBlockHeight: integer(order.started_at), endBlockHeight: integer(order.end), highestBid: jsonSafe(order.highest), bidCount: order.bid_count,
      generation: String(t.name.incarnation.generation), serial: String(t.name.incarnation.serial), custodyNonce: String(order.nonce),
      order: jsonSafe(order), orderJson: stringifyJson(order), escrowed: Boolean(lifecycle?.custody && lifecycle.owner === h(market) && lifecycle.manager === h(market)
        && lifecycle.custody.custodian === h(market) && lifecycle.custody.nonce === String(order.nonce)
        && lifecycle.custody.originOwner === h(t.seller) && lifecycle.custody.originManager === h(t.seller_manager)
        && lifecycle.custody.generation === String(t.name.incarnation.generation) && lifecycle.custody.serial === String(t.name.incarnation.serial)
        && lifecycle.homeShard === h(t.store) && lifecycle.generation === String(t.name.incarnation.generation) && lifecycle.serial === String(t.name.incarnation.serial)) }
    // Full orders retain market/id identity; compatibility singular routes select preferred market only.
    view.marketplaceOrders ??= []; view.marketplaceOrders.push(row)
    if (market !== selected) continue
    if (t.kind === 'Fixed') view.marketplaceFixedSalesByNode.set(node, row)
    if (t.kind === 'Auction') view.marketplaceAuctionsByNode.set(node, row)
    if (t.kind === 'Offer') view.marketplaceOffersByKey.set(marketplaceOfferKey(node, row.buyerAuthority), row)
  }
  view.marketplaceRefunds = Object.entries(s.refunds).map(([key, r]) => ({ marketplaceContractId: h(key.slice(0, 64)), authority: h(r.authority), amountLux: r.amount_lux }))
  for (const r of view.marketplaceRefunds) if (r.marketplaceContractId === h(selected ?? '')) view.marketplaceRefundsByAuthority.set(r.authority, r)
}
