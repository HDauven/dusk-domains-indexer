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
  parseEventLog,
} from './event-log.mjs'
import { deploymentBindingFromEvents } from './deployment-binding.mjs'
import { normalizeName, normalizeNode } from './http.mjs'
import {
  applyControllerEvent,
  applyLifecycleEvent,
  applyMarketplaceEvent,
  applyResolverEvent,
  applyReverseEvent,
  applySubnameEvent,
  clearNodeDerivedState,
  isControllerEvent,
  isFeeConfigEvent,
  isLifecycleEvent,
  isMarketplaceEvent,
  isReferralEvent,
  isResolverEvent,
  isReverseEvent,
  isSubnameEvent,
  isTreasuryEvent,
} from './projectors.mjs'
import { indexedLifecycleBlocksRegistration } from './read-models.mjs'
import { assertSafeNumericTree } from './safe-numbers.mjs'

export async function loadEventLogStore(eventLogFile, cursorFile, options = {}) {
  const parsedLog = parseEventLog(await readFile(eventLogFile, 'utf8'))
  const events = dedupeEventLogEntries(parsedLog.entries)
  const warnings = [...parsedLog.warnings]
  const cursor = await loadCursor(cursorFile)
  const now = new Date().toISOString()
  const state = replayEventLog(events, warnings, now)
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

export function replayEventLog(events, warnings, now) {
  const namesByNode = new Map()
  const recordsByNode = new Map()
  const recordsByNodeKey = new Map()
  const recordHistoryByNode = new Map()
  const recordHistoryByNodeKey = new Map()
  const activityByNode = new Map()
  const reverseByEndpoint = new Map()
  const subnamesByNode = new Map()
  const subnamesByParent = new Map()
  const subnamesByCanonical = new Map()
  const commitmentsById = new Map()
  const controllersByNode = new Map()
  const marketplaceFixedSalesByNode = new Map()
  const marketplaceAuctionsByNode = new Map()
  const marketplaceOffersByKey = new Map()
  const marketplaceRefundsByAuthority = new Map()
  let marketplaceConfig = null
  let treasuryState = emptyTreasuryState()
  let feeConfig = { ...DEFAULT_FEE_CONFIG }
  const referralsByReferrer = new Map()
  let referralRewardsSupported = false

  for (let index = 0; index < events.length; index += 1) {
    const entry = events[index]
    const event = entry?.event ?? entry
    const meta = entry?.meta ?? {}
    if (!event?.type) continue

    try {
      assertSafeNumericTree(event, 'event')
      assertSafeNumericTree(meta, 'event metadata')
      if (isLifecycleEvent(event.type)) {
        applyLifecycleEvent({ namesByNode, activityByNode }, event, meta, now)
        if (event.type === 'name_released') {
          clearNodeDerivedState({
            node: normalizeNode(event.node),
            recordsByNode,
            recordsByNodeKey,
            reverseByEndpoint,
            controllersByNode,
            subnamesByNode,
            subnamesByParent,
            subnamesByCanonical,
          })
        }
      } else if (isResolverEvent(event.type)) {
        applyResolverEvent({
          namesByNode,
          recordsByNode,
          recordsByNodeKey,
          recordHistoryByNode,
          recordHistoryByNodeKey,
          activityByNode,
          controllersByNode,
        }, event, meta, now)
      } else if (isControllerEvent(event.type)) {
        applyControllerEvent({ commitmentsById }, event, meta)
      } else if (isReverseEvent(event.type)) {
        applyReverseEvent({ reverseByEndpoint, activityByNode, namesByNode, controllersByNode }, event, meta)
      } else if (isSubnameEvent(event.type)) {
        applySubnameEvent({ subnamesByNode, subnamesByParent, activityByNode }, event, meta)
      } else if (isTreasuryEvent(event.type)) {
        treasuryState = reduceTreasuryEvent(event, treasuryState, meta)
        if (event.type === 'treasury_initialized') referralRewardsSupported = true
      } else if (isReferralEvent(event.type)) {
        referralRewardsSupported = true
        treasuryState = reduceTreasuryReferralReserve(event, treasuryState)
        treasuryState = reduceTreasuryReferralClaim(event, treasuryState)
        applyReferralEvent({ referralsByReferrer }, event, meta)
      } else if (isFeeConfigEvent(event.type)) {
        feeConfig = reduceFeeConfigEvent(event, feeConfig, meta)
      } else if (isMarketplaceEvent(event.type)) {
        const marketplaceStore = {
          namesByNode,
          marketplaceConfig,
          marketplaceFixedSalesByNode,
          marketplaceAuctionsByNode,
          marketplaceOffersByKey,
          marketplaceRefundsByAuthority,
          activityByNode,
        }
        applyMarketplaceEvent(marketplaceStore, event, meta, now)
        marketplaceConfig = marketplaceStore.marketplaceConfig
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

  for (const [node, lifecycle] of namesByNode) {
    if (!indexedLifecycleBlocksRegistration(lifecycle, new Date(now))) {
      clearNodeDerivedState({
        node,
        recordsByNode,
        recordsByNodeKey,
        reverseByEndpoint,
        controllersByNode,
        subnamesByNode,
        subnamesByParent,
        subnamesByCanonical,
      })
    }
  }

  const namesByCanonical = new Map()
  const indexedAt = new Date(now)
  for (const [node, lifecycle] of namesByNode) {
    if (!lifecycle.canonicalName || !indexedLifecycleBlocksRegistration(lifecycle, indexedAt)) continue
    const records = recordsByNode.get(node) ?? []
    const activity = activityByNode.get(node) ?? []
    namesByCanonical.set(lifecycle.canonicalName, {
      ...lifecycle,
      resolverHealth: lifecycle.resolverId ? 'ok' : 'missing',
      records,
      activity,
      lifecycle,
    })
  }

  for (const subname of subnamesByNode.values()) {
    if (subname?.name) subnamesByCanonical.set(normalizeName(subname.name), subname)
  }

  return {
    namesByCanonical,
    namesByNode,
    activityByNode,
    reverseByEndpoint,
    subnamesByNode,
    subnamesByParent,
    subnamesByCanonical,
    commitmentsById,
    recordsByNode,
    recordsByNodeKey,
    recordHistoryByNode,
    recordHistoryByNodeKey,
    controllersByNode,
    marketplaceConfig,
    marketplaceFixedSalesByNode,
    marketplaceAuctionsByNode,
    marketplaceOffersByKey,
    marketplaceRefundsByAuthority,
    treasuryState,
    feeConfig,
    referralsByReferrer,
    referralRewardsSupported,
  }
}
