import {
  LOCAL_INDEXER_API_VERSION,
  LOCAL_INDEXER_EVENT_SCHEMA_VERSION,
  LOCAL_INDEXER_READ_MODEL_SCHEMA_VERSION,
  LOCAL_INDEXER_SCHEMA_VERSION,
} from './constants.mjs'
import { LOCAL_INDEXER_ROUTE_LIST, numberOrNull } from './http.mjs'
import { LOCAL_INDEXER_PACKAGE_INFO } from './package-info.mjs'

export function healthResponseForStore(store) {
  const currentBlockHeight = storeCurrentBlockHeight(store)
  const finalizedBlockHeight = maxNumberOrNull(
    store?.cursor?.scannedBlockHeight,
    store?.checkpoint?.lastBlockHeight,
    store?.cursor?.lastBlockHeight,
  )
  const lagBlocks = currentBlockHeight !== null && finalizedBlockHeight !== null
    ? Math.max(0, currentBlockHeight - finalizedBlockHeight)
    : null
  const eventCount = numberOrNull(store?.checkpoint?.eventCount)
    ?? numberOrNull(store?.cursor?.eventCount)
    ?? 0
  const lastEvent = lastIndexedEvent(store)
  const warnings = Array.isArray(store?.warnings) ? store.warnings : []
  const degradedReason = healthDegradedReason(store)
  const ok = !degradedReason

  return {
    ok,
    apiVersion: LOCAL_INDEXER_API_VERSION,
    generatedAt: store.generatedAt,
    source: store.source,
    mode: store.mode,
    schemaVersion: LOCAL_INDEXER_SCHEMA_VERSION,
    eventSchemaVersion: LOCAL_INDEXER_EVENT_SCHEMA_VERSION,
    readModelSchemaVersion: LOCAL_INDEXER_READ_MODEL_SCHEMA_VERSION,
    package: LOCAL_INDEXER_PACKAGE_INFO,
    currentBlockHeight,
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
  return maxNumberOrNull(
    store?.cursor?.currentBlockHeight,
    store?.cursor?.scannedBlockHeight,
    store?.cursor?.lastBlockHeight,
    store?.checkpoint?.lastBlockHeight,
  )
}

function lastIndexedEvent(store) {
  const checkpoint = store?.checkpoint
  const cursor = store?.cursor
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
  if (store?.health?.ok !== false) return null
  return {
    code: store.health.code ?? 'indexer_health_degraded',
    message: store.health.message ?? 'Indexer health is degraded.',
  }
}

function maxNumberOrNull(...values) {
  const numbers = values
    .map((value) => numberOrNull(value))
    .filter((value) => value !== null)
  return numbers.length ? Math.max(...numbers) : null
}
