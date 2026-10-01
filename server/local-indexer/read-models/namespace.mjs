import { normalizeNode } from '../http.mjs'
import { lifecycleClock, lifecycleMomentPassed } from './lifecycle.mjs'

// Stored descendants count until removed or pruned, even when their fixed expiry has passed.
export function namespaceForNode(store, node, owner) {
  node = normalizeNode(node)
  const root = store.namesByNode.get(node) ?? store.subnamesByNode.get(node)
  const referenceOwner = normalizeNode(owner ?? root?.owner ?? '')
  const seen = new Set([node])
  const subnames = []
  const clock = lifecycleClock(store)
  for (const parent of seen) {
    for (const subname of store.subnamesByParent.get(parent) ?? []) {
      if (seen.has(subname.node)) continue
      seen.add(subname.node)
      subnames.push({ ...subname, status: lifecycleMomentPassed(subname.expiresAtBlockHeight, subname.expiresAt, clock) ? 'expired' : 'active' })
    }
  }
  const ancestors = []
  let current = store.subnamesByNode.get(node)
  const visited = new Set([node])
  while (current && !visited.has(current.parentNode)) {
    const parentNode = current.parentNode
    visited.add(parentNode)
    const parent = store.subnamesByNode.get(parentNode) ?? store.namesByNode.get(parentNode)
    if (!parent) break
    ancestors.push({ node: parentNode, name: parent.name ?? parent.canonicalName, owner: parent.owner ?? '',
      manager: parent.manager ?? '', expiresAtBlockHeight: parent.expiresAtBlockHeight ?? null })
    current = store.subnamesByNode.get(parentNode)
  }
  return { descendantCount: subnames.length,
    heldByOthersCount: subnames.filter(subname => normalizeNode(subname.owner) !== referenceOwner).length,
    subnames, ancestors }
}

export function namespaceSummary(store, node, owner) {
  const { descendantCount, heldByOthersCount } = namespaceForNode(store, node, owner)
  return { descendantCount, heldByOthersCount }
}
