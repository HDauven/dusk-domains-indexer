import { expect, it } from 'vitest'
import { normalizeObservedEvent, isMarketplaceEvent, isPoolEvent } from '@duskdomains/sdk/projection'
import { replayEventLog } from './event-log-store.mjs'
import { healthResponseForStore } from './health.mjs'

const hex = byte => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`
const principal = { kind: 'Contract', bytes: Array(32).fill(1) }
const observedAt = '2026-10-01T00:00:00.000Z'
const envelope = (eventName, paused, height) => normalizeObservedEvent({
  contract: { key: eventName === 'registrations_paused_changed' ? 'router' : 'marketplace', contractId: hex(9) },
  eventName, event: { paused, operator: eventName === 'registrations_paused_changed' ? principal : Array(32).fill(1), updated_at: height }, observedAt,
})

it('decodes, routes, replays and exposes independent pause changes in health', () => {
  expect(isPoolEvent('registrations_paused_changed')).toBe(true)
  expect(isMarketplaceEvent('trading_paused_changed')).toBe(true)
  const events = []
  const warnings = []
  const health = () => healthResponseForStore(replayEventLog(events, warnings, observedAt)).pause
  expect(health()).toEqual({ registrationsPaused: false, tradingPaused: false })
  events.push(envelope('registrations_paused_changed', true, 10))
  expect(events[0]).toMatchObject({ event: { paused: true, operator: principal, updatedAtBlockHeight: 10 }, meta: { blockHeight: 10 } })
  expect(health()).toEqual({ registrationsPaused: true, tradingPaused: false })
  events.push(envelope('trading_paused_changed', true, 11))
  expect(events[1].event.operator).toBe(hex(1))
  expect(health()).toEqual({ registrationsPaused: true, tradingPaused: true })
  events.push(envelope('registrations_paused_changed', false, 12))
  expect(health()).toEqual({ registrationsPaused: false, tradingPaused: true })
  events.push(envelope('trading_paused_changed', false, 13))
  expect(health()).toEqual({ registrationsPaused: false, tradingPaused: false })
  // Replaying the canonical prefix after a rollback restores the paused state.
  const rolledBack = replayEventLog(events.slice(0, 2), [], observedAt)
  expect(healthResponseForStore(rolledBack).pause).toEqual({ registrationsPaused: true, tradingPaused: true })
  expect(warnings).toEqual([])
})

it('rejects malformed pause payloads', () => {
  for (const paused of [undefined, null, 'false', 0]) expect(() => envelope('trading_paused_changed', paused, 10)).toThrow('boolean')
})
