import {
  LOCAL_INDEXER_API_VERSION,
  LOCAL_INDEXER_EVENT_SCHEMA_VERSION,
  LOCAL_INDEXER_READ_MODEL_SCHEMA_VERSION,
  LOCAL_INDEXER_SCHEMA_VERSION,
} from './constants.mjs'
import { knownChainHeight, cursorHeight } from './chain-height.mjs'
import { LOCAL_INDEXER_ROUTE_LIST, numberOrNull } from './http.mjs'
import { LOCAL_INDEXER_PACKAGE_INFO } from './package-info.mjs'

export function healthResponseForStore(store) {
  const currentBlockHeight = storeCurrentBlockHeight(store)
  const finalizedBlockHeight = store?.cursor?.source === 'rusk-finalized-archive'
    ? cursorHeight(store.cursor.scannedBlockHeight) : null
  const lagBlocks = currentBlockHeight !== null && finalizedBlockHeight !== null
    ? Math.max(0, currentBlockHeight - finalizedBlockHeight)
    : null
  const eventCount = cursorHeight(store?.checkpoint?.eventCount)
    ?? cursorHeight(store?.cursor?.eventCount)
    ?? 0
  const lastEvent = lastIndexedEvent(store)
  const warnings = Array.isArray(store?.warnings) ? store.warnings : []
  const degradedReason = healthDegradedReason(store)
  const ok = !degradedReason

  return {
    ok,
    pause: {
      registrationsPaused: store.poolState?.registrationsPaused ?? false,
      tradingPaused: store.marketplaceConfig?.tradingPaused ?? false,
    },
    apiVersion: LOCAL_INDEXER_API_VERSION,
    generatedAt: store.generatedAt,
    source: store.source,
    mode: store.mode,
    schemaVersion: LOCAL_INDEXER_SCHEMA_VERSION,
    eventSchemaVersion: LOCAL_INDEXER_EVENT_SCHEMA_VERSION,
    readModelSchemaVersion: LOCAL_INDEXER_READ_MODEL_SCHEMA_VERSION,
    package: LOCAL_INDEXER_PACKAGE_INFO,
    currentBlockHeight,
    ...(store.frozen ? { projectionBlockHeight: store.projectionBlockHeight } : {}),
    finalizedBlockHeight,
    lagBlocks,
    eventCount,
    lastEvent,
    routes: LOCAL_INDEXER_ROUTE_LIST,
    names: store.namesByCanonical.size,
    ...(store.deployment ? { deployment: store.deployment } : {}),
    ...(store.sqlite ? { sqlite: store.sqlite } : {}),
    ...(store.durability ? { durability: store.durability } : {}),
    ...(degradedReason ? { degradedReason } : {}),
    ...(warnings.length || degradedReason ? { warnings: [...warnings, ...(degradedReason ? [degradedReason] : [])] } : {}),
    ...(store.cursor ? { cursor: store.cursor } : {}),
    ...(store.checkpoint ? { checkpoint: store.checkpoint } : {}),
  }
}

function storeCurrentBlockHeight(store) {
  return knownChainHeight(store ?? {})
}

function lastIndexedEvent(store) {
  const checkpoint = store?.checkpoint
  const cursor = store?.frozen ? null : store?.cursor
  const eventName = checkpoint?.lastEventName ?? cursor?.lastEventName ?? null
  const blockHeight = numberOrNull(checkpoint?.lastBlockHeight ?? cursor?.lastBlockHeight)
  const txId = checkpoint?.lastTxId ?? cursor?.lastTxId ?? null
  const contract = checkpoint?.lastContract ?? cursor?.lastContract ?? null
  if (!eventName && blockHeight === null && !txId && !contract) return null
  return {
    eventName,
    blockHeight,
    txId,
    contract,
  }
}

function healthDegradedReason(store) {
  if (store?.health?.code === 'publication_candidate_rejected') {
    const { code, step, error, message } = store.health
    return { code, step, error, message }
  }
  const cursor = store?.cursor
  if (cursor?.source === 'w3sper-live-subscription'
    || (['event-log', 'sqlite'].includes(store?.mode) && cursor?.source !== 'rusk-finalized-archive')) {
    return { code: 'history_unverified', message: 'Archive coverage is unverified; start the archive collector (legacy logs need new journal/cursor/SQLite paths).' }
  }
  if (cursor?.source === 'rusk-finalized-archive') {
    const age = Date.now() - Date.parse(cursor.updatedAt)
    const coverageKnown = Number.isSafeInteger(cursor.fromBlock) && cursor.fromBlock > 0
      && Number.isSafeInteger(cursor.scannedBlockHeight) && cursor.scannedBlockHeight >= cursor.fromBlock - 1
      && Number.isSafeInteger(cursor.currentBlockHeight) && cursor.currentBlockHeight >= cursor.scannedBlockHeight
      && /^[0-9a-f]{64}$/.test(cursor.scannedBlockHash ?? '')
    if (!coverageKnown || cursor.status !== 'running' || !Number.isFinite(age) || age < 0 || age > 30_000
      || store?.checkpoint?.eventCount !== cursor.eventCount || store?.warnings?.length) {
      return { code: 'archive_not_caught_up', message: typeof cursor.reason === 'string' ? cursor.reason : 'Archive collector is stopped, stale, or catching up.' }
    }
  }
  if (store?.health?.ok !== false) return null
  return {
    code: store.health.code ?? 'indexer_health_degraded',
    message: store.health.message ?? 'Indexer health is degraded.',
  }
}
