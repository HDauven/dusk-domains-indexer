import { normalizeNode } from '../http.mjs'
import { recordIndexKey } from '../projectors.mjs'

export function listRecordsForNode(store, node) {
  return store.recordsByNode?.get(normalizeNode(node)) ?? []
}

export function recordForNode(store, node, key) {
  return store.recordsByNodeKey?.get(recordIndexKey(node, key)) ?? null
}

export function recordHistoryForNode(store, node, key = null) {
  const normalizedNode = normalizeNode(node)
  if (key) return store.recordHistoryByNodeKey?.get(recordIndexKey(normalizedNode, key)) ?? []
  return store.recordHistoryByNode?.get(normalizedNode) ?? []
}
