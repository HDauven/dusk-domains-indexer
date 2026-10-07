import { normalizeNode } from '../http.mjs'
import { recordIndexKey } from '../view-utils.mjs'
import { indexedNamespaceNodeBlocksRegistration, lifecycleClock } from './lifecycle.mjs'

export function listRecordsForNode(store, node) {
  if (!store.frozen && !indexedNamespaceNodeBlocksRegistration(store, node, lifecycleClock(store))) return []
  return store.recordsByNode?.get(normalizeNode(node)) ?? []
}

export function recordForNode(store, node, key) {
  if (!store.frozen && !indexedNamespaceNodeBlocksRegistration(store, node, lifecycleClock(store))) return null
  return store.recordsByNodeKey?.get(recordIndexKey(node, key)) ?? null
}

export function recordHistoryForNode(store, node, key = null) {
  const normalizedNode = normalizeNode(node)
  if (key !== null) return store.recordHistoryByNodeKey?.get(recordIndexKey(normalizedNode, key)) ?? []
  return store.recordHistoryByNode?.get(normalizedNode) ?? []
}
