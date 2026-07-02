import { describe, expect, it } from 'vitest'

import { loadEventLogStore } from './local-indexer.mjs'
import {
  createExpiredRoutingEventLogFixture,
  createLifecycleCleanupEventLogFixture,
  createReleaseReregistrationEventLogFixture,
  expectJson,
  startServer,
  writeEventLog,
} from './local-indexer-test-helpers.mjs'

describe('local indexer event-log lifecycle cleanup', () => {
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
