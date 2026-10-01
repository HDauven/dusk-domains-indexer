import { expect, it } from 'vitest'
import { applyReplayEvent, createReplayState } from './event-log-store.mjs'

const root = `0x${'01'.repeat(32)}`
const child = `0x${'02'.repeat(32)}`
const expiry = '2040-01-01T00:00:00.000Z'

function fixture() {
  const state = createReplayState()
  const warnings = []
  const apply = event => {
    applyReplayEvent(state, { event }, warnings)
    expect(warnings).toEqual([])
  }
  apply({ type: 'name_registered', node: root, label: 'aurora', actor: 'owner', owner: 'owner',
    expiresAt: expiry, graceEndsAt: expiry, expiresAtBlockHeight: 1000, graceEndsAtBlockHeight: 1100 })
  apply({ type: 'subname_created', node: child, parentNode: root, parentName: 'aurora.dusk',
    name: 'pay.aurora.dusk', label: 'pay', actor: 'owner', owner: 'owner', manager: 'owner', resolver: 'resolver',
    expiresAt: expiry, parentExpiresAt: expiry, expiresAtBlockHeight: null, parentExpiresAtBlockHeight: null,
    expiryPolicy: 'inherits_parent', createdAt: expiry })
  return { state, apply }
}

it('preserves unknown subname heights instead of turning them into block zero', () => {
  const { state } = fixture()
  expect(state.subnamesByNode.get(child)).toMatchObject({ expiresAtBlockHeight: null, parentExpiresAtBlockHeight: null })
})

it('retains a known expiry estimate across ownership changes without an estimate', () => {
  const { state, apply } = fixture()
  apply({ type: 'name_owner_changed', node: root, actor: 'owner', owner: 'next', manager: 'next',
    resolver: 'resolver', expiresAt: null })
  expect(state.namesByNode.get(root).expiresAt).toBe(expiry)
})

it('retains inherited expiry estimates when renewal has no time anchor', () => {
  const { state, apply } = fixture()
  apply({ type: 'name_renewed', node: root, actor: 'next', expiresAt: null, graceEndsAt: null,
    expiresAtBlockHeight: 2000, graceEndsAtBlockHeight: 2100 })
  expect(state.subnamesByNode.get(child)).toMatchObject({ expiresAt: expiry, parentExpiresAt: expiry, expiresAtBlockHeight: 2000 })
})

it('keeps the offer and activity when replay rejects an overflowing refund', () => {
  const state = createReplayState()
  const warnings = []
  const buyerAuthority = `0x${'03'.repeat(32)}`
  const close = amountLux => ({ type: 'domain_offer_closed', node: root, buyerAuthority, amountLux, expired: false, closedAtBlockHeight: 1 })
  applyReplayEvent(state, { event: close(Number.MAX_SAFE_INTEGER) }, warnings)
  applyReplayEvent(state, { event: { type: 'domain_offer_placed', node: root, buyerAuthority,
    amountLux: 1, feeBps: 0, expiresAtBlockHeight: 100, placedAtBlockHeight: 2 } }, warnings)
  const activity = [...state.activityByNode.get(root)]
  applyReplayEvent(state, { event: close(1) }, warnings)
  expect(warnings).toHaveLength(1)
  expect(warnings[0].message).toContain('safe integer range')
  expect([...state.marketplaceOffersByKey.values()]).toMatchObject([{ amountLux: 1 }])
  expect(state.activityByNode.get(root)).toEqual(activity)
})
