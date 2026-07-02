import {
  activityEntry,
  lifecycleActivityTarget,
  lifecycleActivityType,
  lifecycleTimestamp,
} from '../activity.mjs'
import {
  normalizeName,
  normalizeNode,
  numberOrNull,
} from '../http.mjs'

export function applyLifecycleEvent(store, event, meta, fallbackTimestamp) {
  const node = normalizeNode(event.node)
  const current = store.namesByNode.get(node)
  const canonicalName = 'label' in event ? `${event.label}.dusk` : current?.canonicalName ?? node

  store.namesByNode.set(node, reduceLifecycleEvent(event, current, canonicalName))
  store.activityByNode.set(node, [
    activityEntry({
      eventType: lifecycleActivityType(event.type),
      node,
      name: canonicalName,
      actor: event.actor,
      target: lifecycleActivityTarget(event),
      timestamp: lifecycleTimestamp(event) ?? fallbackTimestamp,
      meta,
    }),
    ...(store.activityByNode.get(node) ?? []),
  ])
}

export function clearNodeDerivedState({
  node,
  recordsByNode,
  recordsByNodeKey,
  reverseByEndpoint,
  controllersByNode,
  subnamesByNode,
  subnamesByParent,
  subnamesByCanonical,
}) {
  const normalizedNode = normalizeNode(node)
  const staleNodes = collectNodeTree(normalizedNode, subnamesByNode)

  for (const staleNode of staleNodes) {
    const records = recordsByNode.get(staleNode) ?? []
    recordsByNode.delete(staleNode)
    controllersByNode.delete(staleNode)
    if (recordsByNodeKey) {
      for (const record of records) {
        if (record?.key) recordsByNodeKey.delete(`${staleNode}\u0000${record.key}`)
      }
    }

    const subname = subnamesByNode?.get(staleNode)
    if (subname?.name) subnamesByCanonical?.delete(normalizeName(subname.name))
    subnamesByNode?.delete(staleNode)
  }

  if (subnamesByParent) {
    for (const [parentNode, children] of subnamesByParent) {
      const filtered = children.filter((subname) => !staleNodes.has(normalizeNode(subname.node)))
      if (filtered.length > 0) subnamesByParent.set(parentNode, filtered)
      else subnamesByParent.delete(parentNode)
    }
  }

  for (const [key, reverse] of reverseByEndpoint) {
    if (staleNodes.has(normalizeNode(reverse?.node))) reverseByEndpoint.delete(key)
  }
}

function collectNodeTree(rootNode, subnamesByNode) {
  const staleNodes = new Set([rootNode])
  if (!subnamesByNode) return staleNodes

  let grew = true
  while (grew) {
    grew = false
    for (const subname of subnamesByNode.values()) {
      const childNode = normalizeNode(subname.node)
      if (staleNodes.has(normalizeNode(subname.parentNode)) && !staleNodes.has(childNode)) {
        staleNodes.add(childNode)
        grew = true
      }
    }
  }
  return staleNodes
}

function reduceLifecycleEvent(event, current, canonicalName) {
  const base = current ?? {
    node: normalizeNode(event.node),
    canonicalName,
    owner: null,
    manager: null,
    resolverId: null,
    expiresAt: null,
    graceEndsAt: null,
    expiresAtBlockHeight: null,
    graceEndsAtBlockHeight: null,
    status: 'active',
    lastEventType: event.type,
  }

  if (event.type === 'name_registered') {
    return {
      ...base,
      canonicalName,
      owner: event.owner,
      expiresAt: event.expiresAt,
      graceEndsAt: event.graceEndsAt,
      expiresAtBlockHeight: numberOrNull(event.expiresAtBlockHeight),
      graceEndsAtBlockHeight: numberOrNull(event.graceEndsAtBlockHeight),
      status: 'active',
      lastEventType: event.type,
    }
  }

  if (event.type === 'name_renewed') {
    return {
      ...base,
      expiresAt: event.expiresAt,
      graceEndsAt: event.graceEndsAt,
      expiresAtBlockHeight: numberOrNull(event.expiresAtBlockHeight ?? base.expiresAtBlockHeight),
      graceEndsAtBlockHeight: numberOrNull(event.graceEndsAtBlockHeight ?? base.graceEndsAtBlockHeight),
      status: 'active',
      lastEventType: event.type,
    }
  }

  if (event.type === 'name_expired') {
    return {
      ...base,
      canonicalName,
      owner: event.owner,
      expiresAt: event.expiresAt,
      graceEndsAt: event.graceEndsAt,
      expiresAtBlockHeight: numberOrNull(event.expiresAtBlockHeight ?? base.expiresAtBlockHeight),
      graceEndsAtBlockHeight: numberOrNull(event.graceEndsAtBlockHeight ?? base.graceEndsAtBlockHeight),
      status: 'expired',
      lastEventType: event.type,
    }
  }

  if (event.type === 'name_released') {
    return {
      ...base,
      canonicalName,
      owner: null,
      manager: null,
      resolverId: null,
      expiresAtBlockHeight: null,
      graceEndsAtBlockHeight: null,
      status: 'released',
      lastEventType: event.type,
    }
  }

  if (event.type === 'name_owner_changed') {
    return {
      ...base,
      owner: event.owner,
      manager: event.manager,
      resolverId: event.resolver,
      expiresAt: event.expiresAt,
      expiresAtBlockHeight: numberOrNull(event.expiresAtBlockHeight ?? base.expiresAtBlockHeight),
      status: 'active',
      lastEventType: event.type,
    }
  }

  return {
    ...base,
    resolverId: event.resolver,
    lastEventType: event.type,
  }
}
