import {
  normalizeName,
  normalizeNode,
} from '../http.mjs'

export function indexedLifecycleBlocksRegistration(lifecycle, now) {
  if (!lifecycle) return false
  if (lifecycle.status === 'released') return false
  if (lifecycle.status === 'revoked') return false
  if (lifecycle.graceEndsAt && new Date(lifecycle.graceEndsAt).getTime() <= now.getTime()) return false
  if (!lifecycle.graceEndsAt && lifecycle.expiresAt && new Date(lifecycle.expiresAt).getTime() <= now.getTime()) return false
  return true
}

export function indexedSubnameBlocksRegistration(store, subname, now) {
  if (!subname) return false
  if (subname.status !== 'active') return false
  if (subname.expiresAt && new Date(subname.expiresAt).getTime() <= now.getTime()) return false
  return indexedNamespaceNodeBlocksRegistration(store, subname.parentNode, now)
}

export function indexedNamespaceNodeBlocksRegistration(store, node, now, seen = new Set()) {
  const normalizedNode = normalizeNode(node)
  if (seen.has(normalizedNode)) return false
  seen.add(normalizedNode)

  const lifecycle = store.namesByNode.get(normalizedNode)
  if (lifecycle) return indexedLifecycleBlocksRegistration(lifecycle, now)

  const subname = store.subnamesByNode.get(normalizedNode)
  if (!subname) return false
  if (subname.status !== 'active') return false
  if (subname.expiresAt && new Date(subname.expiresAt).getTime() <= now.getTime()) return false
  return indexedNamespaceNodeBlocksRegistration(store, subname.parentNode, now, seen)
}

export function liveSubnameForNode(store, node, now = new Date()) {
  const subname = store.subnamesByNode.get(normalizeNode(node))
  if (!indexedSubnameBlocksRegistration(store, subname, now)) return null
  return subname
}

export function subnameLifecycleForNode(store, node) {
  const subname = liveSubnameForNode(store, node)
  if (!subname) return null
  return subnameLifecycle(subname)
}

export function subnameLifecycle(subname) {
  return {
    node: normalizeNode(subname.node),
    canonicalName: normalizeName(subname.name),
    owner: subname.owner ?? null,
    manager: subname.manager ?? null,
    resolverId: subname.resolver ?? null,
    expiresAt: subname.expiresAt ?? null,
    graceEndsAt: null,
    status: subname.status ?? 'active',
    lastEventType: subname.lastEventType ?? 'subname_created',
  }
}
