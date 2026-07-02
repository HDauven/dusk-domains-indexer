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
  const subname = reduceSubnameEvent(event, current, meta)
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

function reduceSubnameEvent(event, current, meta) {
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
      parentExpiresAt: event.parentExpiresAt,
      expiresAtBlockHeight: numberOrNull(event.expiresAtBlockHeight),
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
    parentExpiresAt: '',
    expiresAtBlockHeight: null,
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
