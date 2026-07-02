import { endpointKey } from '../naming.mjs'
import {
  normalizeName,
  normalizeNode,
} from '../http.mjs'
import {
  indexedNamespaceNodeBlocksRegistration,
  indexedSubnameBlocksRegistration,
} from './lifecycle.mjs'

export function listNames(store, owner) {
  const ownerFilter = String(owner ?? '').trim().toLowerCase()

  return [...store.namesByCanonical.values()]
    .filter((name) => {
      if (!ownerFilter) return true
      return String(name.lifecycle.owner ?? '').toLowerCase() === ownerFilter
        || String(name.lifecycle.manager ?? '').toLowerCase() === ownerFilter
        || [...(store.controllersByNode?.get(name.node) ?? [])]
          .some((controller) => String(controller).toLowerCase() === ownerFilter)
    })
    .map((name) => ({
      ...name.lifecycle,
      records: name.records,
      ...primarySummaryForName(store, name),
      subnameCount: activeSubnamesForParent(store, name.node).length,
      activityCount: store.activityByNode.get(name.node)?.length ?? 0,
    }))
    .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName))
}

export function activeSubnamesForParent(store, parentNode) {
  const now = new Date()
  if (!indexedNamespaceNodeBlocksRegistration(store, parentNode, now)) return []
  return (store.subnamesByParent.get(parentNode) ?? [])
    .filter((subname) => indexedSubnameBlocksRegistration(store, subname, now))
}

function primarySummaryForName(store, name) {
  const moonlightRecord = (name.records ?? []).find((record) => record.key === 'moonlight_address')
  if (!moonlightRecord) return { primaryName: null, primaryStatus: 'no_address' }

  const reverse = store.reverseByEndpoint.get(endpointKey({
    type: 'moonlight_address',
    value: moonlightRecord.value,
  }))
  const primaryName = reverse?.primaryName ?? reverse?.name ?? null

  if (!primaryName) return { primaryName: null, primaryStatus: 'missing' }
  if (
    normalizeName(primaryName) === name.lifecycle.canonicalName
    && normalizeNode(reverse?.node) === normalizeNode(name.node)
  ) {
    return { primaryName, primaryStatus: 'verified' }
  }
  return { primaryName, primaryStatus: 'mismatch' }
}
