import { expect, it } from 'vitest'
import { projectedPrimary, nameStateKey, slotStateKey } from '@duskdomains/sdk/projection'
import { encodeBase58, hex } from '@duskdomains/sdk'
import { bytes, id, createEventLog, envelope, receipt, recordEffects, rootNode, prefixed, vaultEvents, claimEvents } from '../../scripts/test-fixtures/frozen-events.mjs'
import { populationEntries, populationBytes } from '../../scripts/test-fixtures/frozen-population.mjs'
import { createReplayState, applyReplayEvent, finalizeReplayState } from './frozen-view.mjs'
import { compareKeys, listKey } from './pagination.mjs'

function population(size) {
  const state = createReplayState(), warnings = []
  for (const entry of populationEntries(size)) applyReplayEvent(state, entry, warnings)
  expect(warnings).toEqual([])
  return state
}

it.each([20, 40])('publishes %s populated names with bounded passes over every shared collection', size => {
  const state = population(size), scans = {}, projection = state.projection
  for (const key of ['names', 'primaries', 'forwards', 'moves', 'referrals', 'markets']) {
    scans[key] = 0
    projection[key] = new Proxy(projection[key], { ownKeys(target) { scans[key]++; return Reflect.ownKeys(target) } })
  }
  let registrationReads = 0
  for (const effect of projection.effects) {
    if (effect.topic !== 'root_registered') continue
    const name = effect.data.body.name, referrer = name.referrer
    Object.defineProperty(name, 'referrer', { get() { registrationReads++; return referrer }, configurable: true })
  }
  const view = finalizeReplayState(state, '2026-10-07T12:00:00Z', 200)
  expect(view.namesByNode.size).toBe(size + 1)
  expect(view.reverseByEndpoint.size).toBe(size + 1)
  expect(view.marketplaceOrders).toHaveLength(size)
  expect(view.moves.length).toBeGreaterThan(1)
  expect(view.forwards).toHaveLength(1)
  expect(view.recordsByNode.size).toBe(size + 2)
  const expectedOrder = [...view.namesByCanonical.values()].sort((a, b) => compareKeys(listKey('/names', a), listKey('/names', b)))
  expect(view.namesByAuthority.get(`0x${id(10)}`)).toEqual(expectedOrder)
  const publicationScans = { ...scans }
  for (let i = 0; i < size; i++) {
    const endpoint = populationBytes(i, 96)
    const sdk = projectedPrimary(projection, endpoint, 200n)
    expect(view.reverseByEndpoint.get(`moonlight_address:${encodeBase58(endpoint)}`)).toMatchObject({
      homeShard: `0x${sdk.store}`, node: `0x${hex(sdk.name.key.node)}`, verified: true,
    })
    expect(view.referralsByReferrer.get(`Contract:${hex(populationBytes(i))}`).referralCount).toBe(1)
  }
  // Count publication work independently of the SDK oracle implementation.
  expect.soft(publicationScans).toEqual({ names: 1, primaries: 1, forwards: 1, moves: 1, referrals: 1, markets: 1 })
  expect.soft(registrationReads).toBeLessThanOrEqual(3 * (size + 1))
})

it.each(['expired', 'generation', 'serial', 'missing name', 'no pointer', 'different endpoint', 'missing slot', 'bad digest', 'duplicate endpoint'])(
  'matches SDK primary verification for %s', kind => {
    const state = population(1), s = state.projection, endpoint = populationBytes(0, 96)
    const [primaryKey, primary] = Object.entries(s.primaries).find(([, p]) => hex(p.endpoint) === hex(endpoint))
    const store = primaryKey.slice(0, 64), nameKey = nameStateKey(store, primary.name.key), name = s.names[nameKey]
    const slotKey = slotStateKey(id(5), { registry: bytes(4), node: name.key.node, epoch: 1n })
    // Corrupt independent test state where needed to exercise the SDK's fail-closed checks.
    if (kind === 'expired') name.expires_at = 200n
    if (kind === 'generation') name.incarnation.generation++
    if (kind === 'serial') name.incarnation.serial++
    if (kind === 'missing name') delete s.names[nameKey]
    if (kind === 'no pointer') name.records = null
    if (kind === 'different endpoint') primary.endpoint = populationBytes(99, 96)
    if (kind === 'missing slot') delete s.slots[slotKey]
    if (kind === 'bad digest') name.records.digest = bytes(0)
    if (kind === 'duplicate endpoint') {
      s.primaries[primaryKey.replace(store, id(8))] = structuredClone(primary)
      s.names[nameStateKey(id(8), name.key)] = structuredClone(name)
      s.slots[slotStateKey(id(5), { registry: bytes(8), node: name.key.node, epoch: 1n })] = structuredClone(s.slots[slotKey])
    }
    if (['missing slot', 'bad digest', 'duplicate endpoint'].includes(kind)) {
      expect(() => projectedPrimary(s, endpoint, 200n)).toThrow()
      expect(() => finalizeReplayState(state, '2026-10-07T12:00:00Z', 200)).toThrow()
    } else {
      expect(projectedPrimary(s, endpoint, 200n)).toBeNull()
      expect(finalizeReplayState(state, '2026-10-07T12:00:00Z', 200).reverseByEndpoint.has(`moonlight_address:${encodeBase58(endpoint)}`)).toBe(false)
    }
  },
)

it.each([40, 80, 160])('appends %s concentrated edits without rewriting retained history', count => {
  const state = createReplayState(), warnings = [], rewrites = {}
  for (const entry of [...createEventLog(), envelope(receipt(15, recordEffects('https://initial.example'))), vaultEvents(), claimEvents()]) applyReplayEvent(state, entry, warnings)
  const before = finalizeReplayState(state, '2026-10-07T12:00:00Z'), snapshot = structuredClone(before)
  const watch = (rows, key) => new Proxy(rows, { set(target, property, value) {
    if (/^\d+$/.test(String(property)) && Number(property) < target.length) rewrites[key]++
    return Reflect.set(target, property, value)
  } })
  for (const key of ['activityByNode', 'recordHistoryByNode', 'recordHistoryByNodeKey', 'referralEvents']) {
    rewrites[key] = 0
    for (const [node, rows] of state[key]) state[key].set(node, watch(rows, key))
  }
  rewrites.treasuryEvents = 0
  state.treasuryEvents = watch(state.treasuryEvents, 'treasuryEvents')
  for (let i = 0; i < count; i++) {
    applyReplayEvent(state, envelope(receipt(20 + i * 3, recordEffects(`https://edit-${i}.example`))), warnings)
    applyReplayEvent(state, vaultEvents(21 + i * 3), warnings)
    applyReplayEvent(state, claimEvents(22 + i * 3), warnings)
  }
  expect(warnings).toEqual([])
  // Count writes to existing positions, so both unshift and a manual shifting loop fail.
  expect.soft(rewrites).toEqual(Object.fromEntries(Object.keys(rewrites).map(key => [key, 0])))
  const view = finalizeReplayState(state, '2026-10-07T12:00:00Z')
  const history = view.recordHistoryByNodeKey.get(`${rootNode}:website`)
  expect(history.map(row => row.value)).toEqual([...Array.from({ length: count }, (_, i) => `https://edit-${count - 1 - i}.example`), 'https://initial.example'])
  for (const rows of [view.activityByNode.get(rootNode), view.recordHistoryByNode.get(rootNode), view.treasuryState.events,
    view.treasuryState.claims, view.referralsByReferrer.get(prefixed(13)).events, view.referralsByReferrer.get(prefixed(13)).recentActivity]) {
    expect(rows.length).toBeGreaterThan(1)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].blockHeight * 100 + rows[i - 1].eventIndex).toBeGreaterThanOrEqual(rows[i].blockHeight * 100 + rows[i].eventIndex)
    }
  }
  expect(view.namesByNode.get(rootNode).lastEventType).toBe('slot_changed')
  expect(view.treasuryState.lastEventType).toBe('protocol_claimed')
  expect(before).toEqual(snapshot)
})
