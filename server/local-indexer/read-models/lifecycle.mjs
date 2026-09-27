import { knownChainHeight } from '../chain-height.mjs'
import {
  normalizeName,
  normalizeNode,
  numberOrNull,
} from '../http.mjs'

// Whether a name is still held is decided by block heights, which are exact. The ISO dates in
// a projection are estimates made when the event was decoded, and are only consulted for
// projections that carry no heights.
export function lifecycleClock(store, date = new Date()) {
  return { blockHeight: knownChainHeight(store ?? {}), date }
}

function clockOf(now) {
  if (now instanceof Date) return { blockHeight: null, date: now }
  return now ?? { blockHeight: null, date: new Date() }
}

export function lifecycleMomentPassed(blockHeight, isoDate, now) {
  const clock = clockOf(now)
  const height = numberOrNull(blockHeight)
  if (clock.blockHeight !== null && height !== null) return clock.blockHeight >= height
  if (isoDate) return new Date(isoDate).getTime() <= clock.date.getTime()
  return false
}

export function indexedLifecycleBlocksRegistration(lifecycle, now) {
  if (!lifecycle) return false
  if (lifecycle.status === 'released') return false
  if (lifecycle.status === 'revoked') return false
  const hasGrace = numberOrNull(lifecycle.graceEndsAtBlockHeight) !== null || Boolean(lifecycle.graceEndsAt)
  if (hasGrace) return !lifecycleMomentPassed(lifecycle.graceEndsAtBlockHeight, lifecycle.graceEndsAt, now)
  return !lifecycleMomentPassed(lifecycle.expiresAtBlockHeight, lifecycle.expiresAt, now)
}

function subnameExpired(subname, now) {
  return lifecycleMomentPassed(subname.expiresAtBlockHeight, subname.expiresAt, now)
}

export function indexedSubnameBlocksRegistration(store, subname, now) {
  if (!subname) return false
  if (subname.status !== 'active') return false
  if (subnameExpired(subname, now)) return false
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
  if (subnameExpired(subname, now)) return false
  return indexedNamespaceNodeBlocksRegistration(store, subname.parentNode, now, seen)
}

export function liveSubnameForNode(store, node, now = lifecycleClock(store)) {
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
    expiresAtBlockHeight: numberOrNull(subname.expiresAtBlockHeight),
    graceEndsAt: null,
    status: subname.status ?? 'active',
    lastEventType: subname.lastEventType ?? 'subname_created',
  }
}
