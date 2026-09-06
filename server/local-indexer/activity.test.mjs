import { expect, it } from 'vitest'
import { replayEventLog } from './event-log-store.mjs'
import { confirmedEventBlockHeight, dedupeEventLogEntries } from './event-log.mjs'

it('replays distinct activity IDs and observation times independently of replay time', () => {
  const node = '0x' + '11'.repeat(32)
  const actor = '0x' + '22'.repeat(32)
  const observedAt = '2026-06-27T12:00:00.000Z'
  const events = [1, 2].map(amountLux => ({
    event: { type: 'domain_offer_placed', node, buyerAuthority: actor, amountLux, feeBps: 250, expiresAtBlockHeight: 500 },
    meta: { observedAt, blockHeight: 100 },
  }))
  events.push({ event: { type: 'name_renewed', node, actor, expiresAt: '2028-06-27T12:00:00.000Z' }, meta: { observedAt } })
  const warnings = []
  const first = replayEventLog(events, warnings, '2026-06-27T12:01:00.000Z').activityByNode.get(node)
  const second = replayEventLog(events, warnings, '2026-06-27T12:02:00.000Z').activityByNode.get(node)
  expect(warnings).toEqual([])
  expect(first).toEqual(second)
  expect(new Set(first.map(row => row.id)).size).toBe(3)
  expect(first.map(row => row.timestamp)).toEqual([observedAt, observedAt, observedAt])
  expect(events.every(entry => !entry.meta.eventId)).toBe(true)
})

it('does not relabel legacy polled heights as confirmed event heights', () => {
  const meta = { source: 'w3sper-live-subscription', blockHeight: 95 }
  expect(confirmedEventBlockHeight({ type: 'domain_bid_placed', placedAtBlockHeight: 100 }, meta)).toBe(100)
  expect(confirmedEventBlockHeight({ type: 'record_cleared' }, meta)).toBeNull()
  expect(confirmedEventBlockHeight({ type: 'registration_committed' }, meta)).toBe(95)
  expect(confirmedEventBlockHeight({ type: 'record_cleared' }, { blockHeight: 100, txId: 'tx' })).toBe(100)
})

it('preserves distinct persisted log identities while deduplicating replayed envelopes', () => {
  const event = { type: 'record_cleared', node: '0x' + '11'.repeat(32), key: 'text.description' }
  const a = { event, meta: { eventId: 'log:1' } }
  const b = { event, meta: { eventId: 'log:2' } }
  expect(dedupeEventLogEntries([a, b, a])).toEqual([a, b])
})
