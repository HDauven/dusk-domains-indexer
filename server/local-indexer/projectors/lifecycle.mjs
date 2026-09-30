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

  const lifecycle = reduceLifecycleEvent(event, current, canonicalName)
  // An authority change gives a subname a name row, which starts with the subname's grace end.
  const subname = current ? null : store.subnamesByNode.get(node)
  store.namesByNode.set(node, subname
    ? { ...lifecycle, graceEndsAt: subname.graceEndsAt ?? null, graceEndsAtBlockHeight: subname.graceEndsAtBlockHeight ?? null }
    : lifecycle)
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

// Moved records keep their content; the name now resolves through the resolver holding them.
// A subname whose authorities changed has a name row too, and both follow the move.
export function applyRecordsMoved(store, event, meta, fallbackTimestamp) {
  const node = normalizeNode(event.node)
  if (store.namesByNode.has(node)) {
    const resolverChanged = { type: 'resolver_changed', node, actor: event.controller, resolver: event.toResolver }
    applyLifecycleEvent(store, resolverChanged, meta, fallbackTimestamp)
  }
  const subname = store.subnamesByNode.get(node)
  if (!subname) return
  const moved = { ...subname, resolver: event.toResolver }
  const parentNode = normalizeNode(subname.parentNode)
  store.subnamesByNode.set(node, moved)
  const siblings = store.subnamesByParent.get(parentNode) ?? []
  store.subnamesByParent.set(parentNode, siblings.map((candidate) => (candidate.node === node ? moved : candidate)))
}

// Releasing a name, or registering a lapsed one again, also drops the name rows its subnames got
// from authority changes.
export function clearReleasedName(store, node) {
  for (const staleNode of clearNodeDerivedState({ ...store, node })) {
    if (staleNode !== node) store.namesByNode.delete(staleNode)
  }
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
  return staleNodes
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

  if (event.type === 'name_registered' || event.type === 'name_renewed' || event.type === 'name_expired') {
    const retained = event.type === 'name_registered' ? null : base
    return {
      ...base,
      ...(event.type === 'name_renewed' ? {} : { canonicalName, owner: event.owner }),
      expiresAt: event.expiresAt,
      graceEndsAt: event.graceEndsAt,
      expiresAtBlockHeight: numberOrNull(event.expiresAtBlockHeight ?? retained?.expiresAtBlockHeight),
      graceEndsAtBlockHeight: numberOrNull(event.graceEndsAtBlockHeight ?? retained?.graceEndsAtBlockHeight),
      status: event.type === 'name_expired' ? 'expired' : 'active',
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
