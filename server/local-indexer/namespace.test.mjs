import { expect, it } from 'vitest'
import { createProjectionState, applyProjectionEvent, normalizeObservedEvent } from '@duskdomains/sdk/projection'
import { namespaceForNode, namespaceSummary } from './read-models/namespace.mjs'

const root = `0x${'11'.repeat(32)}`, child = `0x${'22'.repeat(32)}`, leaf = `0x${'33'.repeat(32)}`
const expiresAt = '2040-01-01T00:00:00Z'
function stateWithNamespace() {
  const state = createProjectionState()
  applyProjectionEvent(state, { type: 'name_registered', node: root, label: 'alice', owner: 'seller', actor: 'seller', expiresAt, graceEndsAt: expiresAt })
  for (const [node, parentNode, name, owner] of [[child, root, 'docs.alice.dusk', 'seller'], [leaf, child, 'api.docs.alice.dusk', 'other']]) {
    applyProjectionEvent(state, { type: 'subname_created', node, parentNode, name, owner, manager: owner, resolver: '', expiresAt, parentExpiresAt: expiresAt, expiryPolicy: 'inherits_parent', createdAt: expiresAt })
  }
  return state
}
it('counts the complete namespace and follows transfers and escrow seller attribution', () => {
  const state = stateWithNamespace()
  expect(namespaceSummary(state, root)).toEqual({ descendantCount: 2, heldByOthersCount: 1 })
  applyProjectionEvent(state, { type: 'name_owner_changed', node: root, owner: 'marketplace', manager: 'marketplace', actor: 'seller', expiresAt })
  expect(namespaceSummary(state, root)).toEqual({ descendantCount: 2, heldByOthersCount: 2 })
  expect(namespaceSummary(state, root, 'seller').heldByOthersCount).toBe(1)
  expect(namespaceForNode(state, leaf).ancestors.map(row => row.owner)).toEqual(['seller', 'marketplace'])
  applyProjectionEvent(state, { type: 'name_owner_changed', node: child, owner: 'buyer', manager: 'manager', actor: 'buyer', expiresAt, dataCleared: true })
  expect(state.subnamesByNode.get(child)).toMatchObject({ owner: 'buyer', manager: 'manager' })
  expect(state.namesByNode.has(child)).toBe(false)
  expect(namespaceSummary(state, root, 'buyer').heldByOthersCount).toBe(1)
  applyProjectionEvent(state, { type: 'subname_removed', node: child, parentNode: root, actor: 'buyer', name: 'docs.alice.dusk', removedAt: expiresAt })
  expect(namespaceSummary(state, root)).toEqual({ descendantCount: 0, heldByOthersCount: 0 })
})
it('includes expired stored subnames for take-back and capacity visibility', () => {
  const state = stateWithNamespace()
  const expired = { ...state.subnamesByNode.get(leaf), expiresAt: '2000-01-01T00:00:00Z' }
  state.subnamesByNode.set(leaf, expired)
  state.subnamesByParent.set(child, [expired])
  expect(namespaceForNode(state, root).subnames.find(row => row.node === leaf).status).toBe('expired')
  expect(namespaceSummary(state, root).descendantCount).toBe(2)
})

it('serves summaries and complete descendant lists on name and marketplace routes', async () => {
  const { startServer, expectJson } = await import('../local-indexer-test-helpers.mjs')
  const state = stateWithNamespace()
  state.marketplaceFixedSalesByNode.set(root, { node: root, sellerAuthority:'seller', marketplaceContractId:`0x${'44'.repeat(32)}` })
  const { baseUrl, close } = await startServer(state)
  try {
    const name = await expectJson(`${baseUrl}/name?node=${root}`)
    expect(name.namespace).toMatchObject({descendantCount:2,heldByOthersCount:1})
    expect(name.namespace.subnames.map(row=>row.node)).toEqual([child,leaf])
    const sale = await expectJson(`${baseUrl}/marketplace/fixed-sale?node=${root}`)
    expect(sale.namespace).toEqual({descendantCount:2,heldByOthersCount:1})
    const nested = await expectJson(`${baseUrl}/name?node=${leaf}`)
    expect(nested.canonicalName).toBe('api.docs.alice.dusk')
    expect(nested.namespace.ancestors.map(row=>row.node)).toEqual([child,root])
  } finally { await close() }
})

it('retains expired stored descendants when reading an offline snapshot', async () => {
  const { writeSnapshot } = await import('../local-indexer-test-helpers.mjs')
  const { loadSnapshotStore } = await import('./snapshot.mjs')
  const state = stateWithNamespace()
  const names = [...state.namesByNode.values()].map(lifecycle => ({...lifecycle, records:[]}))
  const subnames = [...state.subnamesByNode.values()].map(row => ({...row,expiresAt:'2000-01-01T00:00:00Z'}))
  const path = await writeSnapshot({names,subnames})
  const store = await loadSnapshotStore(path)
  expect(namespaceForNode(store, root).subnames).toHaveLength(2)
  expect(namespaceForNode(store, root).subnames.every(row=>row.status==='expired')).toBe(true)
})


it.each([false, true])('decodes and replays transfer reset %s for roots and subnames', clear => {
  for (const node of [root, child]) {
    const state = stateWithNamespace()
    for (const target of [root, child, leaf]) {
      applyProjectionEvent(state, {type:'record_changed',node:target,controller:'seller',record:{key:'website',value:'https://seller.example',type:'text'}})
      applyProjectionEvent(state, {type:'primary_name_changed',node:target,controller:'seller',endpoint:{type:'moonlight_address',value:target},name:target,updatedAt:expiresAt})
    }
    const decoded = normalizeObservedEvent({contract:{key:'core',contractId:'44'.repeat(32)},eventName:'name_owner_changed',observedAt:'2026-01-01T00:00:00Z',event:{
      node,actor:'55'.repeat(32),previous_owner:'55'.repeat(32),owner:'66'.repeat(32),manager:'66'.repeat(32),resolver:'00'.repeat(32),expires_at:1000,data_cleared:clear,
    }})
    expect(decoded.event.dataCleared).toBe(clear)
    applyProjectionEvent(state, decoded.event)
    expect((node === root ? state.namesByNode : state.subnamesByNode).get(node)).toMatchObject({owner:`0x${'66'.repeat(32)}`,manager:`0x${'66'.repeat(32)}`})
    expect(state.recordsByNode.has(node)).toBe(!clear)
    expect(state.recordsByNodeKey.has(`${node}\u0000website`)).toBe(!clear)
    expect(state.reverseKeysByNode.has(node)).toBe(!clear)
    expect(state.reverseByEndpoint.has(`moonlight_address:${node}`)).toBe(!clear)
    for (const untouched of [root, child, leaf].filter(target => target !== node)) {
      expect(state.recordsByNode.get(untouched)).toHaveLength(1)
      expect(state.reverseKeysByNode.has(untouched)).toBe(true)
    }
    expect(state.subnamesByNode.get(leaf).owner).toBe('other')
    expect(state.namesByNode.has(child)).toBe(false)
    expect(namespaceForNode(state, root).descendantCount).toBe(2)
  }
})
