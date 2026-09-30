import { readFile } from 'node:fs/promises'
import { newestEventTimestamp } from './activity.mjs'
import {
  createReplayCheckpoint,
  indexerDurabilityState,
  loadCursor,
  loadDurableCheckpoint,
} from './checkpoint.mjs'
import { DEFAULT_FEE_CONFIG } from './constants.mjs'
import {
  applyReferralEvent,
  emptyTreasuryState,
  reduceFeeConfigEvent,
  reduceTreasuryEvent,
  reduceTreasuryReferralClaim,
  reduceTreasuryReferralReserve,
} from './economics.mjs'
import {
  dedupeEventLogEntries,
  confirmedEventBlockHeight,
  eventTimestamp,
  parseEventLog,
} from './event-log.mjs'
import { knownChainHeight, maxNumberOrNull } from './chain-height.mjs'
import { deploymentBindingFromEvents } from './deployment-binding.mjs'
import { normalizeName, normalizeNode } from './http.mjs'
import {
  applyControllerEvent,
  applyLifecycleEvent,
  applyRecordsMoved,
  applyMarketplaceEvent,
  applyResolverEvent,
  applyReverseEvent,
  applySubnameEvent,
  clearNodeDerivedState,
  clearReleasedName,
  emptyPoolState,
  isControllerEvent,
  isFeeConfigEvent,
  isLifecycleEvent,
  isMarketplaceEvent,
  isPoolEvent,
  isReferralEvent,
  isResolverEvent,
  isReverseEvent,
  isSubnameEvent,
  isTreasuryEvent,
  reducePoolEvent,
  renewInheritingSubnames,
} from './projectors.mjs'
import { indexedLifecycleBlocksRegistration } from './read-models.mjs'
import { assertSafeNumericTree } from './safe-numbers.mjs'

export async function loadEventLogStore(eventLogFile, cursorFile, options = {}) {
  const parsedLog = parseEventLog(await readFile(eventLogFile, 'utf8'))
  const events = dedupeEventLogEntries(parsedLog.entries)
  const warnings = [...parsedLog.warnings]
  const cursor = await loadCursor(cursorFile)
  const now = new Date().toISOString()
  const state = replayEventLog(events, warnings, now, knownChainHeight({ cursor }))
  const checkpoint = createReplayCheckpoint(events, parsedLog.entries.length, warnings, now)
  const durableCheckpoint = await loadDurableCheckpoint(options.checkpointFile)
  const durability = indexerDurabilityState({
    cursor,
    checkpoint,
    durableCheckpoint,
    warnings,
    strictHealth: Boolean(options.strictHealth),
    maxLagBlocks: options.maxLagBlocks,
    eventLogFile,
    cursorFile,
    checkpointFile: options.checkpointFile,
  })
  return {
    generatedAt: newestEventTimestamp(events) ?? now,
    source: 'local-indexer-event-log',
    mode: 'event-log',
    warnings,
    events,
    deployment: deploymentBindingFromEvents(events),
    cursor,
    checkpoint,
    durableCheckpoint: durableCheckpoint?.ok ? durableCheckpoint.value : null,
    durability,
    ...(durability.ok ? {} : { health: {
      ok: false,
      code: durability.code,
      message: durability.message,
    } }),
    ...state,
  }
}

// Replays events in order. Which names are still held is decided at the chain height: the
// caller's view of the tip, or at least the height of the newest event.
export function replayEventLog(events, warnings, now, chainHeight = null) {
  const state = createReplayState()
  for (const entry of events) applyReplayEvent(state, entry, warnings)
  return finalizeReplayState(state, now, chainHeight)
}

// The projections every event folds into. Kept apart from the served view so new events can be
// applied to it without replaying the journal.
export function createReplayState() {
  return {
    namesByNode: new Map(),
    recordsByNode: new Map(),
    recordsByNodeKey: new Map(),
    recordHistoryByNode: new Map(),
    recordHistoryByNodeKey: new Map(),
    activityByNode: new Map(),
    reverseByEndpoint: new Map(),
    subnamesByNode: new Map(),
    subnamesByParent: new Map(),
    subnamesByCanonical: new Map(),
    commitmentsById: new Map(),
    commitmentsByKey: new Map(),
    controllersByNode: new Map(),
    marketplaceFixedSalesByNode: new Map(),
    marketplaceAuctionsByNode: new Map(),
    marketplaceOffersByKey: new Map(),
    marketplaceRefundsByAuthority: new Map(),
    marketplaceConfig: null,
    treasuryState: emptyTreasuryState(),
    feeConfig: { ...DEFAULT_FEE_CONFIG },
    poolState: emptyPoolState(),
    referralsByReferrer: new Map(),
    referralRewardsSupported: false,
    newestEventHeight: null,
    appliedCount: 0,
  }
}

export function applyReplayEvent(state, entry, warnings) {
  const index = state.appliedCount
  state.appliedCount += 1
  const event = entry?.event ?? entry
  const meta = { ...entry?.meta, eventId: entry?.meta?.eventId ?? `replay:${index}` }
  const timestamp = eventTimestamp(event, meta)
  if (!event?.type) return

  try {
    assertSafeNumericTree(event, 'event')
    assertSafeNumericTree(meta, 'event metadata')
    meta.blockHeight = confirmedEventBlockHeight(event, meta)
    if (Number.isFinite(meta.blockHeight)) state.newestEventHeight = Math.max(state.newestEventHeight ?? 0, meta.blockHeight)
    if (isLifecycleEvent(event.type)) {
      const node = normalizeNode(event.node)
      // The contract clears a lapsed name it registers again without emitting name_released.
      if (event.type === 'name_registered' && state.namesByNode.has(node)) clearReleasedName(state, node)
      applyLifecycleEvent(state, event, meta, timestamp)
      if (event.type === 'name_renewed') renewInheritingSubnames(state, node)
      if (event.type === 'name_released') clearReleasedName(state, node)
    } else if (isResolverEvent(event.type)) {
      applyResolverEvent(state, event, meta, timestamp)
    } else if (isControllerEvent(event.type)) {
      applyControllerEvent(state, event, meta)
    } else if (isReverseEvent(event.type)) {
      applyReverseEvent(state, event, meta)
    } else if (isSubnameEvent(event.type)) {
      applySubnameEvent(state, event, meta)
    } else if (isTreasuryEvent(event.type)) {
      state.treasuryState = reduceTreasuryEvent(event, state.treasuryState, meta)
      if (event.type === 'treasury_initialized') state.referralRewardsSupported = true
    } else if (isReferralEvent(event.type)) {
      state.referralRewardsSupported = true
      state.treasuryState = reduceTreasuryReferralReserve(event, state.treasuryState)
      state.treasuryState = reduceTreasuryReferralClaim(event, state.treasuryState)
      applyReferralEvent(state, event, meta)
    } else if (isFeeConfigEvent(event.type)) {
      state.feeConfig = reduceFeeConfigEvent(event, state.feeConfig, meta)
    } else if (isMarketplaceEvent(event.type)) {
      applyMarketplaceEvent(state, event, meta, timestamp)
    } else if (isPoolEvent(event.type)) {
      state.poolState = reducePoolEvent(event, state.poolState, meta)
      if (event.type === 'records_moved') applyRecordsMoved(state, event, meta, timestamp)
      // The router starts with a fee config; later changes arrive as fee_config_updated.
      if (event.type === 'router_initialized') state.feeConfig = reduceFeeConfigEvent(event, state.feeConfig, meta)
    }
  } catch (error) {
    warnings.push({
      code: 'invalid_event_log_event',
      index: index + 1,
      type: event.type,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

// The served view: names past their grace period lose their records, reverse entries and
// subnames. Maps that change are copied, so the replay state stays intact for later events.
export function finalizeReplayState(state, now, chainHeight = null) {
  const view = {
    ...state,
    recordsByNode: new Map(state.recordsByNode),
    recordsByNodeKey: new Map(state.recordsByNodeKey),
    reverseByEndpoint: new Map(state.reverseByEndpoint),
    controllersByNode: new Map(state.controllersByNode),
    subnamesByNode: new Map(state.subnamesByNode),
    subnamesByParent: new Map(state.subnamesByParent),
    subnamesByCanonical: new Map(state.subnamesByCanonical),
  }
  const clock = { blockHeight: maxNumberOrNull(chainHeight, state.newestEventHeight), date: new Date(now) }

  for (const [node, lifecycle] of view.namesByNode) {
    if (!indexedLifecycleBlocksRegistration(lifecycle, clock)) clearNodeDerivedState({ ...view, node })
  }

  const namesByCanonical = new Map()
  for (const [node, lifecycle] of view.namesByNode) {
    if (!lifecycle.canonicalName || !indexedLifecycleBlocksRegistration(lifecycle, clock)) continue
    namesByCanonical.set(lifecycle.canonicalName, {
      ...lifecycle,
      resolverHealth: lifecycle.resolverId ? 'ok' : 'missing',
      records: view.recordsByNode.get(node) ?? [],
      activity: view.activityByNode.get(node) ?? [],
      lifecycle,
    })
  }

  for (const subname of view.subnamesByNode.values()) {
    if (subname?.name) view.subnamesByCanonical.set(normalizeName(subname.name), subname)
  }

  return {
    namesByCanonical,
    namesByNode: view.namesByNode,
    activityByNode: view.activityByNode,
    reverseByEndpoint: view.reverseByEndpoint,
    subnamesByNode: view.subnamesByNode,
    subnamesByParent: view.subnamesByParent,
    subnamesByCanonical: view.subnamesByCanonical,
    commitmentsById: view.commitmentsById,
    commitmentsByKey: view.commitmentsByKey,
    recordsByNode: view.recordsByNode,
    recordsByNodeKey: view.recordsByNodeKey,
    recordHistoryByNode: view.recordHistoryByNode,
    recordHistoryByNodeKey: view.recordHistoryByNodeKey,
    controllersByNode: view.controllersByNode,
    marketplaceConfig: view.marketplaceConfig,
    marketplaceFixedSalesByNode: view.marketplaceFixedSalesByNode,
    marketplaceAuctionsByNode: view.marketplaceAuctionsByNode,
    marketplaceOffersByKey: view.marketplaceOffersByKey,
    marketplaceRefundsByAuthority: view.marketplaceRefundsByAuthority,
    treasuryState: view.treasuryState,
    feeConfig: view.feeConfig,
    poolState: view.poolState,
    referralsByReferrer: view.referralsByReferrer,
    referralRewardsSupported: view.referralRewardsSupported,
    nextLifecycleBoundary: nextLifecycleBoundary(view.namesByNode, view.subnamesByNode, clock.blockHeight),
  }
}

// The lowest expiry or grace height still ahead. Until the chain reaches it, a new tip cannot
// change which names are held, so the view can be reused.
function nextLifecycleBoundary(namesByNode, subnamesByNode, height) {
  let next = null
  const consider = (value) => {
    const boundary = Number(value)
    if (value == null || !Number.isFinite(boundary) || (height !== null && boundary <= height)) return
    next = next === null ? boundary : Math.min(next, boundary)
  }
  for (const lifecycle of namesByNode.values()) {
    consider(lifecycle.expiresAtBlockHeight)
    consider(lifecycle.graceEndsAtBlockHeight)
  }
  for (const subname of subnamesByNode.values()) consider(subname.expiresAtBlockHeight)
  return next
}
