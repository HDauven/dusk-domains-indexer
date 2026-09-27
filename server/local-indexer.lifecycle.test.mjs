import { describe, expect, it } from 'vitest'

import { loadEventLogStore } from './local-indexer.mjs'
import { replayEventLog } from './local-indexer/event-log-store.mjs'
import {
  createExpiredRoutingEventLogFixture,
  createLifecycleCleanupEventLogFixture,
  createReleaseReregistrationEventLogFixture,
  expectJson,
  startServer,
  writeCursor,
  writeEventLog,
} from './local-indexer-test-helpers.mjs'

describe('local indexer event-log lifecycle cleanup', () => {
  // Legacy logs carry ISO dates that were anchored wrongly; heights decide instead.
  it('decides whether a name is held from block heights, not its estimated dates', async () => {
    const registration = (label, byte, expiresAtBlockHeight, graceEndsAtBlockHeight, dates) => ({
      event: {
        type: 'name_registered',
        node: `0x${byte.repeat(32)}`,
        label,
        actor: '0xowner',
        owner: '0xowner',
        expiresAtBlockHeight,
        graceEndsAtBlockHeight,
        ...dates,
      },
      meta: { txId: `tx-${label}`, blockHeight: 900 },
    })
    const eventLogFile = await writeEventLog([
      // Expired by height although its dates claim 2099.
      registration('lapsed', 'a1', 950, 990, { expiresAt: '2099-01-01T00:00:00.000Z', graceEndsAt: '2099-02-01T00:00:00.000Z' }),
      // Held by height although its dates are already past.
      registration('current', 'b2', 5000, 6000, { expiresAt: '2001-01-01T00:00:00.000Z', graceEndsAt: '2001-02-01T00:00:00.000Z' }),
      // In grace by height: expired, but nobody else can claim it yet.
      registration('grace', 'c3', 990, 1100, { expiresAt: '2001-01-01T00:00:00.000Z', graceEndsAt: '2001-02-01T00:00:00.000Z' }),
    ])
    const cursorFile = await writeCursor({ currentBlockHeight: 1000, scannedBlockHeight: 1000 })
    const store = await loadEventLogStore(eventLogFile, cursorFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/search?query=lapsed`)).resolves.toMatchObject({ status: 'available' })
      expect(store.namesByNode.get(`0x${'a1'.repeat(32)}`)).toMatchObject({ canonicalName: 'lapsed.dusk' })
      await expect(expectJson(`${baseUrl}/search?query=current`)).resolves.toMatchObject({ status: 'registered' })
      await expect(expectJson(`${baseUrl}/search?query=grace`)).resolves.toMatchObject({ status: 'registered' })
      await expect(expectJson(`${baseUrl}/resolve?name=current.dusk`)).resolves.toMatchObject({ expiry: { status: 'active' } })
      await expect(expectJson(`${baseUrl}/resolve?name=grace.dusk`)).resolves.toMatchObject({ expiry: { status: 'expired' } })
    } finally {
      await close()
    }
  })

  it('falls back to the newest event height when no collector cursor is available', () => {
    const store = replayEventLog([
      { event: { type: 'name_registered', node: `0x${'cc'.repeat(32)}`, label: 'fallback', actor: 'o', owner: 'o',
        expiresAtBlockHeight: 10, graceEndsAtBlockHeight: 20, expiresAt: '2099-01-01T00:00:00Z', graceEndsAt: '2099-02-01T00:00:00Z' },
        meta: { blockHeight: 5 } },
      { event: { type: 'later_event_marker' }, meta: { blockHeight: 25 } },
    ], [], '2000-01-01T00:00:00Z')
    expect(store.namesByCanonical.has('fallback.dusk')).toBe(false)
  })

  it('normalizes lifecycle heights while distinguishing registration from renewal and expiry', () => {
    const event = {
      node: 'AA'.repeat(32), label: 'aurora', actor: 'owner', owner: 'owner',
      expiresAt: '2040-01-01T00:00:00Z', graceEndsAt: '2040-02-01T00:00:00Z',
      observedAt: '2040-01-02T00:00:00Z',
    }
    for (const type of ['name_registered', 'name_renewed', 'name_expired']) {
      const warnings = []
      const store = replayEventLog([
        { event: { ...event, type: 'name_registered', expiresAtBlockHeight: '100', graceEndsAtBlockHeight: '200' } },
        { event: { ...event, type } },
      ], warnings, '2030-01-01T00:00:00Z')
      expect(warnings).toEqual([])
      expect(store.namesByNode.get(`0x${event.node.toLowerCase()}`)).toMatchObject({
        expiresAtBlockHeight: type === 'name_registered' ? null : 100,
        graceEndsAtBlockHeight: type === 'name_registered' ? null : 200,
        status: type === 'name_expired' ? 'expired' : 'active',
      })
    }
  })

  it('marks released event-log names available while preserving lifecycle history', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const owner = '0xowner'
    const eventLogFile = await writeEventLog([
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: owner,
          owner,
          expiresAt: '2027-06-17T00:00:00.000Z',
          graceEndsAt: '2027-07-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'name_released',
          node,
          label: 'aurora',
          actor: owner,
          previousOwner: owner,
          releasedAt: '2027-07-18T00:00:00.000Z',
        },
        meta: { txId: 'tx-release', blockHeight: 2 },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/search?query=aurora`)).resolves.toMatchObject({
        canonical: 'aurora.dusk',
        status: 'available',
        transactionBlocked: false,
      })
      await expect(expectJson(`${baseUrl}/name?node=${node}`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        status: 'released',
        owner: null,
      })
    } finally {
      await close()
    }
  })

  it('clears stale resolver and reverse state when an event-log name is released', async () => {
    const { events, node, owner, nextOwner, moonlight } = createReleaseReregistrationEventLogFixture()
    const eventLogFile = await writeEventLog(events)
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/search?query=aurora`)).resolves.toMatchObject({
        canonical: 'aurora.dusk',
        status: 'registered',
        transactionBlocked: true,
      })
      await expect(expectJson(`${baseUrl}/resolve?name=aurora`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        records: [],
      })
      await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${moonlight}`)).resolves.toBeNull()
      await expect(expectJson(`${baseUrl}/names?owner=${owner}`)).resolves.toEqual([])
      await expect(expectJson(`${baseUrl}/names?owner=${nextOwner}`)).resolves.toMatchObject([{
        canonicalName: 'aurora.dusk',
        owner: nextOwner,
        records: [],
      }])
    } finally {
      await close()
    }
  })

  it('does not expose post-grace expired event-log names as active routing state', async () => {
    const { events, node, subnode, owner, moonlight } = createExpiredRoutingEventLogFixture()
    const eventLogFile = await writeEventLog(events)
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/search?query=aurora`)).resolves.toMatchObject({
        canonical: 'aurora.dusk',
        status: 'available',
        transactionBlocked: false,
      })
      await expect(expectJson(`${baseUrl}/name?node=${node}`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        status: 'expired',
        owner,
      })
      await expect(expectJson(`${baseUrl}/resolve?name=aurora`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        records: [],
        resolver: {
          health: 'missing',
        },
        verificationStatus: 'unverified',
      })
      await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${moonlight}`)).resolves.toBeNull()
      await expect(expectJson(`${baseUrl}/names?owner=${owner}`)).resolves.toEqual([])
      await expect(expectJson(`${baseUrl}/subnames?parentNode=${node}`)).resolves.toEqual([])
      await expect(expectJson(`${baseUrl}/subname?node=${subnode}`)).resolves.toBeNull()
    } finally {
      await close()
    }
  })

  it('replays record clears, primary clears, and subname lifecycle updates without stale state', async () => {
    const { events, node, subnode, manager, nextManager, moonlight } = createLifecycleCleanupEventLogFixture()
    const eventLogFile = await writeEventLog(events)
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      const resolution = await expectJson(`${baseUrl}/resolve?name=aurora.dusk`)
      expect(resolution.records).toMatchObject([{
        key: 'moonlight_address',
        value: moonlight,
      }])
      expect(resolution.records).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'website' }),
      ]))
      await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${moonlight}`)).resolves.toBeNull()
      await expect(expectJson(`${baseUrl}/subnames?parentNode=${node}`)).resolves.toEqual([])
      await expect(expectJson(`${baseUrl}/subname?node=${subnode}`)).resolves.toBeNull()
      await expect(expectJson(`${baseUrl}/activity?node=${node}`)).resolves.toMatchObject([
        { eventType: 'subname_revoked', target: 'revoked' },
        { eventType: 'subname_delegated', target: nextManager },
        { eventType: 'subname_created', target: manager },
        { eventType: 'primary_name', target: `moonlight_address:${moonlight}` },
        { eventType: 'primary_name', target: `moonlight_address:${moonlight}` },
        { eventType: 'record_update', target: 'website' },
        { eventType: 'record_update', target: 'website' },
        { eventType: 'record_update', target: 'moonlight_address' },
        { eventType: 'transfer' },
        { eventType: 'registration' },
      ])
    } finally {
      await close()
    }
  })
})
