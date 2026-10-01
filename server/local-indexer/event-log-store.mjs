import { readFile } from 'node:fs/promises'
import { newestEventTimestamp } from './activity.mjs'
import {
  createReplayCheckpoint,
  indexerDurabilityState,
  loadCursor,
  loadDurableCheckpoint,
} from './checkpoint.mjs'
import {
  dedupeEventLogEntries,
  confirmedEventBlockHeight,
  eventTimestamp,
  parseEventLog,
} from './event-log.mjs'
import { knownChainHeight, maxNumberOrNull } from './chain-height.mjs'
import { deploymentBindingFromEvents } from './deployment-binding.mjs'
import { normalizeName } from './http.mjs'
import {
  createProjectionState,
  applyProjectionEvent,
  clearNodeDerivedState,
  assertSafeNumericTree,
} from '@duskdomains/sdk/projection'
import { indexedLifecycleBlocksRegistration } from './read-models.mjs'

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
  return { ...createProjectionState(), newestEventHeight: null, appliedCount: 0 }
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
    applyProjectionEvent(state, event, meta, timestamp)
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
    reverseKeysByNode: new Map(state.reverseKeysByNode),
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
