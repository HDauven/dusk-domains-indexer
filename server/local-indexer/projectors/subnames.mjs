import {
  activityEntry,
  subnameTimestamp,
} from '../activity.mjs'
import {
  normalizeName,
  normalizeNode,
} from '../http.mjs'

export function applySubnameEvent(store, event, meta) {
  const parentNode = normalizeNode(event.parentNode)
  const node = normalizeNode(event.node)
  const current = store.subnamesByNode.get(node)
  const parent = store.subnamesByNode.get(parentNode) ?? store.namesByNode.get(parentNode)
  const subname = reduceSubnameEvent(event, current, meta, parent)
  const entry = activityEntry({
    eventType: event.type,
    node,
    name: event.name,
    actor: event.actor,
    target: event.type === 'subname_revoked' ? 'revoked' : event.manager,
    timestamp: subnameTimestamp(event),
    meta,
  })

  if (subname.status === 'active') {
    store.subnamesByNode.set(node, subname)
    store.subnamesByParent.set(parentNode, [
      subname,
      ...(store.subnamesByParent.get(parentNode) ?? []).filter((candidate) => candidate.node !== node),
    ])
  } else {
    store.subnamesByNode.delete(node)
    const remaining = (store.subnamesByParent.get(parentNode) ?? [])
      .filter((candidate) => candidate.node !== node)
    if (remaining.length > 0) store.subnamesByParent.set(parentNode, remaining)
    else store.subnamesByParent.delete(parentNode)
  }
  store.activityByNode.set(node, [entry, ...(store.activityByNode.get(node) ?? [])])
  store.activityByNode.set(parentNode, [entry, ...(store.activityByNode.get(parentNode) ?? [])])
}

// Renewing a root renews each subname that inherits its expiry. A fixed subname keeps its own,
// and so do the subnames below it.
export function renewInheritingSubnames(store, rootNode) {
  const root = store.namesByNode.get(rootNode)
  const parents = new Set([rootNode])
  for (const parentNode of parents) {
    const children = store.subnamesByParent.get(parentNode)
    if (!children) continue
    store.subnamesByParent.set(parentNode, children.map((subname) => {
      if (subname.expiryPolicy !== 'inherits_parent') return subname
      const lifecycle = {
        expiresAt: root.expiresAt,
        graceEndsAt: root.graceEndsAt,
        expiresAtBlockHeight: root.expiresAtBlockHeight,
        graceEndsAtBlockHeight: root.graceEndsAtBlockHeight,
      }
      const renewed = { ...subname, ...lifecycle }
      store.subnamesByNode.set(subname.node, renewed)
      // An authority change gives a subname a name row too, which renews with it.
      const row = store.namesByNode.get(subname.node)
      if (row) store.namesByNode.set(subname.node, { ...row, ...lifecycle })
      parents.add(subname.node)
      return renewed
    }))
  }
}

function reduceSubnameEvent(event, current, meta, parent) {
  if (event.type === 'subname_created') {
    return {
      parentNode: normalizeNode(event.parentNode),
      node: normalizeNode(event.node),
      parentName: event.parentName,
      name: event.name,
      canonicalName: normalizeName(event.name),
      label: event.label,
      owner: event.owner,
      manager: event.manager,
      resolver: event.resolver,
      expiresAt: event.expiresAt,
      graceEndsAt: parent?.graceEndsAt ?? null,
      parentExpiresAt: event.parentExpiresAt,
      expiresAtBlockHeight: numberOrNull(event.expiresAtBlockHeight),
      graceEndsAtBlockHeight: parent?.graceEndsAtBlockHeight ?? null,
      parentExpiresAtBlockHeight: numberOrNull(event.parentExpiresAtBlockHeight),
      expiryPolicy: event.expiryPolicy,
      revocationPolicy: event.revocationPolicy,
      status: 'active',
      createdAt: event.createdAt,
      revokedAt: null,
      lastEventType: event.type,
      txId: meta.txId ?? null,
      blockHeight: meta.blockHeight ?? null,
    }
  }

  const base = current ?? {
    parentNode: normalizeNode(event.parentNode),
    node: normalizeNode(event.node),
    parentName: event.name.split('.').slice(1).join('.'),
    name: event.name,
    canonicalName: normalizeName(event.name),
    label: event.name.split('.')[0] ?? event.name,
    owner: '',
    manager: '',
    resolver: '',
    expiresAt: '',
    graceEndsAt: null,
    parentExpiresAt: '',
    expiresAtBlockHeight: null,
    graceEndsAtBlockHeight: null,
    parentExpiresAtBlockHeight: null,
    expiryPolicy: 'inherits_parent',
    revocationPolicy: 'parent_revocable',
    status: 'active',
    createdAt: '',
    revokedAt: null,
    lastEventType: event.type,
    txId: null,
    blockHeight: null,
  }

  if (event.type === 'subname_delegated') {
    return {
      ...base,
      manager: event.manager,
      lastEventType: event.type,
      txId: meta.txId ?? base.txId,
      blockHeight: meta.blockHeight ?? base.blockHeight,
    }
  }

  return {
    ...base,
    status: 'revoked',
    revokedAt: event.revokedAt,
    lastEventType: event.type,
    txId: meta.txId ?? base.txId,
    blockHeight: meta.blockHeight ?? base.blockHeight,
  }
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
