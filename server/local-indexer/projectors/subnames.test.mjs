import { describe, expect, it, vi } from 'vitest'
import { applyReplayEvent, createReplayState, finalizeReplayState } from '../event-log-store.mjs'

const root = `0x${'01'.repeat(32)}`
const child = `0x${'02'.repeat(32)}`
const leaf = `0x${'03'.repeat(32)}`
const expiry = '2040-01-01T00:00:00.000Z'
const oldExpiry = '2020-01-01T00:00:00.000Z'
const created = (node, parentNode, name) => ({
  type: 'subname_created', node, parentNode, name, parentName: name.split('.').slice(1).join('.'),
  label: name.split('.')[0], actor: 'parent', owner: 'old-owner', manager: 'old-manager', resolver: 'old-resolver',
  expiresAt: oldExpiry, expiresAtBlockHeight: 100, parentExpiresAt: expiry, parentExpiresAtBlockHeight: 1000,
  expiryPolicy: 'fixed_before_parent', createdAt: '2019-01-01T00:00:00.000Z',
})

describe('subname recreation and pruning', () => {
  it('replays fresh children with linear map work and no cleanup', () => {
    const replay = (parents) => {
      const state = createReplayState()
      const warnings = []
      const work = measureMapWork(() => {
        for (let p = 0; p < parents; p++) {
          const parentNode = `0x${(p + 1).toString(16).padStart(64, '0')}`
          applyReplayEvent(state, { event: { type: 'name_registered', node: parentNode,
            label: `parent${p}`, owner: 'owner', expiresAt: expiry } }, warnings)
          for (let c = 0; c < 64; c++) {
            const node = `0x${(1000 + p * 64 + c).toString(16).padStart(64, '0')}`
            applyReplayEvent(state, { event: created(node, parentNode, `child${c}.parent${p}.dusk`) }, warnings)
          }
        }
      })
      expect(warnings).toEqual([])
      expect(state.subnamesByNode.size).toBe(parents * 64)
      return work
    }
    const small = replay(100)
    const large = replay(200)
    expect(large.scanned).toBe(0)
    expect(large.deleted).toBe(0)
    expect(large.lookups).toBeLessThanOrEqual(small.lookups * 2.1)
  }, 60_000)

  it.each(['recreate', 'prune'])('removes the complete stale subtree on %s', (action) => {
    const state = createReplayState()
    const warnings = []
    const apply = (event) => applyReplayEvent(state, { event, meta: { blockHeight: 100 } }, warnings)
    apply({ type: 'name_registered', node: root, label: 'acme', actor: 'parent', owner: 'parent',
      expiresAt: expiry, graceEndsAt: '2041-01-01T00:00:00.000Z', expiresAtBlockHeight: 1000, graceEndsAtBlockHeight: 2000 })
    apply(created(child, root, 'pay.acme.dusk'))
    apply(created(leaf, child, 'tip.pay.acme.dusk'))
    for (const node of [child, leaf]) {
      apply({ type: 'name_owner_changed', node, actor: 'old-owner', owner: 'old-owner', manager: 'old-manager',
        resolver: 'old-resolver', expiresAt: oldExpiry, expiresAtBlockHeight: 100 })
      apply({ type: 'record_changed', node, controller: 'old-owner',
        record: { key: 'website', value: 'https://old.example', updatedAt: oldExpiry, ttlSeconds: 60, visibility: 'public' } })
      apply({ type: 'primary_name_changed', node, endpoint: { type: 'moonlight_address', value: node },
        controller: 'old-owner', name: node, previousName: null, updatedAt: oldExpiry })
    }
    if (action === 'recreate') {
      apply({ ...created(child, root, 'pay.acme.dusk'), owner: 'new-owner', manager: 'new-manager', resolver: '',
        expiresAt: expiry, expiresAtBlockHeight: 1000 })
      expect(state.subnamesByNode.get(child)).toMatchObject({ owner: 'new-owner', manager: 'new-manager', resolver: '' })
      expect(state.subnamesByParent.get(root)).toHaveLength(1)
    } else {
      apply({ type: 'subname_pruned', node: child, parentNode: root, name: 'pay.acme.dusk', actor: 'parent', prunedAt: oldExpiry })
      expect(state.subnamesByNode.has(child)).toBe(false)
      expect(state.subnamesByParent.has(root)).toBe(false)
    }
    apply({ type: 'name_renewed', node: root, actor: 'parent', expiresAt: '2042-01-01T00:00:00.000Z',
      graceEndsAt: '2043-01-01T00:00:00.000Z', expiresAtBlockHeight: 3000, graceEndsAtBlockHeight: 4000 })
    const view = finalizeReplayState(state, '2026-01-01T00:00:00.000Z', 100)
    expect(view.subnamesByNode.has(leaf)).toBe(false)
    expect(view.subnamesByParent.has(child)).toBe(false)
    expect(view.subnamesByCanonical.has('tip.pay.acme.dusk')).toBe(false)
    for (const node of [child, leaf]) {
      expect(view.namesByNode.has(node)).toBe(false)
      expect(view.recordsByNode.has(node)).toBe(false)
      expect(view.recordsByNodeKey.has(`${node}\u0000website`)).toBe(false)
      expect(view.controllersByNode.has(node)).toBe(false)
      expect(view.reverseByEndpoint.has(`moonlight_address:${node}`)).toBe(false)
      expect(view.recordHistoryByNodeKey.get(`${node}\u0000website`)).toHaveLength(1)
    }
    expect(warnings).toEqual([])
  })

  it.each(['recreate', 'prune', 'reregister', 'release'])('cleans only indexed descendants and primary names on %s', (action) => {
    const state = createReplayState()
    const warnings = []
    const apply = (event) => applyReplayEvent(state, { event }, warnings)
    const sibling = `0x${'04'.repeat(32)}`
    const register = (node) => apply({ type: 'name_registered', node, label: 'acme', owner: 'owner',
      expiresAt: expiry, graceEndsAt: '2041-01-01T00:00:00.000Z' })
    const primary = (node, value, name = node) => apply({ type: 'primary_name_changed', node,
      endpoint: { type: 'moonlight_address', value }, controller: 'owner', name, previousName: null, updatedAt: oldExpiry })
    const getPrimary = (value) => state.reverseByEndpoint.get(`moonlight_address:${value}`)
    register(root)
    register(sibling)
    apply(created(child, root, 'pay.acme.dusk'))
    apply(created(leaf, child, 'tip.pay.acme.dusk'))
    for (const node of [root, child, leaf, sibling]) primary(node, node)
    primary(child, 'moved')
    primary(sibling, 'moved')
    primary(leaf, 'cleared')
    primary(sibling, 'cleared', null)
    const work = measureMapWork(() => {
      if (action === 'recreate') apply(created(child, root, 'pay.acme.dusk'))
      else if (action === 'prune') apply({ type: 'subname_pruned', parentNode: root, node: child,
        name: 'pay.acme.dusk', actor: 'owner', prunedAt: oldExpiry })
      else if (action === 'reregister') register(root)
      else apply({ type: 'name_released', node: root, label: 'acme', actor: 'owner', releasedAt: expiry })
    })
    expect(work.scanned).toBe(0)
    expect(getPrimary(child)).toBeUndefined()
    expect(getPrimary(leaf)).toBeUndefined()
    expect(getPrimary('cleared')).toBeUndefined()
    expect(getPrimary('moved')?.node).toBe(sibling)
    expect(getPrimary(sibling)?.node).toBe(sibling)
    expect(getPrimary(root)?.node ?? null).toBe(['recreate', 'prune'].includes(action) ? root : null)
    expect(state.subnamesByParent.has(child)).toBe(false)
    expect((state.subnamesByParent.get(root) ?? []).map((subname) => subname.node)).toEqual(action === 'recreate' ? [child] : [])
    if (action === 'release') register(root)
    apply(created(child, root, 'pay.acme.dusk'))
    apply(created(leaf, child, 'tip.pay.acme.dusk'))
    primary(leaf, 'again')
    register(root)
    expect(state.subnamesByParent.has(root)).toBe(false)
    expect(state.subnamesByParent.has(child)).toBe(false)
    expect(getPrimary('again')).toBeUndefined()
    register(sibling)
    expect(getPrimary('moved')).toBeUndefined()
    expect(state.reverseKeysByNode.size).toBe(0)
    expect(warnings).toEqual([])
  })

  it('keeps replay indexes intact when finalizing an expired namespace', () => {
    const state = createReplayState()
    const apply = (event) => applyReplayEvent(state, { event }, [])
    apply({ type: 'name_registered', node: root, label: 'acme', owner: 'owner', expiresAt: expiry,
      graceEndsAt: '2041-01-01T00:00:00.000Z' })
    apply({ ...created(child, root, 'pay.acme.dusk'), expiresAt: expiry })
    apply({ type: 'primary_name_changed', node: child, endpoint: { type: 'moonlight_address', value: child },
      controller: 'owner', name: 'pay.acme.dusk', updatedAt: oldExpiry })
    const expired = finalizeReplayState(state, '2042-01-01T00:00:00.000Z')
    expect(expired.reverseByEndpoint.size).toBe(0)
    expect(expired.subnamesByNode.size).toBe(0)
    const active = finalizeReplayState(state, '2030-01-01T00:00:00.000Z')
    expect(active.reverseByEndpoint.size).toBe(1)
    expect(active.subnamesByParent.get(root)).toHaveLength(1)
    apply({ ...created(child, root, 'pay.acme.dusk'), expiresAt: expiry })
    expect(state.reverseByEndpoint.size).toBe(0)
    expect(state.reverseKeysByNode.size).toBe(0)
  })

  it('updates parent expiry metadata while keeping fixed expiry and inheriting descendants in sync', () => {
    const state = createReplayState()
    const apply = (event) => applyReplayEvent(state, { event }, [])
    apply({ type: 'name_registered', node: root, label: 'acme', owner: 'parent', expiresAt: expiry })
    apply({ ...created(child, root, 'pay.acme.dusk'), expiryPolicy: 'inherits_parent', expiresAt: expiry })
    apply({ ...created(leaf, child, 'tip.pay.acme.dusk'), expiresAt: expiry })
    const renewed = '2042-01-01T00:00:00.000Z'
    apply({ type: 'name_renewed', node: root, expiresAt: renewed, expiresAtBlockHeight: 3000 })
    expect(state.subnamesByNode.get(child)).toMatchObject({ expiresAt: renewed, parentExpiresAt: renewed, parentExpiresAtBlockHeight: 3000 })
    expect(state.subnamesByNode.get(leaf)).toMatchObject({ expiresAt: expiry, parentExpiresAt: renewed, parentExpiresAtBlockHeight: 3000 })
    expect(state.subnamesByParent.get(child)[0]).toEqual(state.subnamesByNode.get(leaf))
  })
})

// Count map work instead of asserting a machine-dependent wall-clock threshold.
function measureMapWork(action) {
  const work = { scanned: 0, deleted: 0, lookups: 0 }
  const values = Map.prototype.values
  const entries = Map.prototype[Symbol.iterator]
  const get = Map.prototype.get
  const remove = Map.prototype.delete
  const spies = [
    vi.spyOn(Map.prototype, 'values').mockImplementation(function* () {
      for (const value of values.call(this)) { work.scanned++; yield value }
    }),
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* () {
      for (const entry of entries.call(this)) { work.scanned++; yield entry }
    }),
    vi.spyOn(Map.prototype, 'get').mockImplementation(function (key) {
      work.lookups++
      return get.call(this, key)
    }),
    vi.spyOn(Map.prototype, 'delete').mockImplementation(function (key) {
      work.deleted++
      return remove.call(this, key)
    }),
  ]
  try { action() } finally { for (const spy of spies) spy.mockRestore() }
  return work
}
