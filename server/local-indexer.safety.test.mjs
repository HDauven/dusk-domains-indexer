import { describe, expect, it } from 'vitest'

import { loadEventLogStore } from './local-indexer.mjs'
import {
  createEventLog,
  expectJson,
  startServer,
  writeEventLog,
} from './local-indexer-test-helpers.mjs'

describe('local indexer event-log safety checks', () => {
  it('fails closed for invalid replayed resolver records', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const owner = '0xowner'
    const resolver = `0x${'cc'.repeat(32)}`
    const eventLogFile = await writeEventLog([
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: owner,
          owner,
          expiresAt: '2999-06-17T00:00:00.000Z',
          graceEndsAt: '2999-07-17T00:00:00.000Z',
          feeLux: 10,
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'name_owner_changed',
          node,
          actor: owner,
          owner,
          manager: owner,
          resolver,
          expiresAt: '2999-06-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-owner', blockHeight: 2 },
      },
      {
        event: {
          type: 'record_changed',
          node,
          controller: owner,
          record: {
            key: 'evm_address',
            value: '0xnot-an-evm-address',
            visibility: 'public',
            updatedAt: new Date().toISOString(),
            ttlSeconds: 300,
          },
        },
        meta: { txId: 'tx-record', blockHeight: 3 },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/resolve?name=aurora.dusk`)).resolves.toMatchObject({
        verificationStatus: 'unverified',
        resolver: {
          health: 'invalid',
        },
        errors: [{
          code: 'invalid_record',
          message: expect.stringContaining('EVM addresses must be 20-byte hex strings'),
        }],
      })
    } finally {
      await close()
    }
  })

  it('keeps cleared resolver records out of current indexes while preserving history', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const owner = '0xowner'
    const resolver = `0x${'cc'.repeat(32)}`
    const eventLogFile = await writeEventLog([
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: owner,
          owner,
          expiresAt: '2999-06-17T00:00:00.000Z',
          graceEndsAt: '2999-07-17T00:00:00.000Z',
          feeLux: 10,
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'name_owner_changed',
          node,
          actor: owner,
          owner,
          manager: owner,
          resolver,
          expiresAt: '2999-06-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-owner', blockHeight: 2 },
      },
      {
        event: {
          type: 'record_changed',
          node,
          controller: owner,
          record: {
            key: 'website',
            value: 'https://dusk.domains',
            visibility: 'public',
            updatedAt: '2026-06-17T00:00:00.000Z',
            ttlSeconds: 300,
          },
        },
        meta: { txId: 'tx-set', blockHeight: 3, eventIndex: 0 },
      },
      {
        event: {
          type: 'record_cleared',
          node,
          controller: owner,
          key: 'website',
        },
        meta: { txId: 'tx-clear', blockHeight: 4, eventIndex: 0 },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/records?node=${node}`)).resolves.toEqual([])
      await expect(expectJson(`${baseUrl}/record?node=${node}&key=website`)).resolves.toBeNull()
      await expect(expectJson(`${baseUrl}/record-history?node=${node}&key=website`)).resolves.toMatchObject([
        {
          action: 'clear',
          key: 'website',
          previousRecord: {
            value: 'https://dusk.domains',
          },
          txId: 'tx-clear',
          blockHeight: 4,
        },
        {
          action: 'set',
          key: 'website',
          record: {
            value: 'https://dusk.domains',
          },
          previousRecord: null,
          txId: 'tx-set',
          blockHeight: 3,
        },
      ])
    } finally {
      await close()
    }
  })

  it('serves recent-change warnings from replayed event-log activity', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const owner = '0xowner'
    const controller = '0xcontroller'
    const resolver = `0x${'cc'.repeat(32)}`
    const recordUpdatedAt = new Date(Date.now() - 120_000).toISOString()
    const primaryUpdatedAt = new Date(Date.now() - 180_000).toISOString()
    const eventLogFile = await writeEventLog([
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: owner,
          owner,
          expiresAt: '2999-06-17T00:00:00.000Z',
          graceEndsAt: '2999-07-17T00:00:00.000Z',
          feeLux: 10,
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'name_owner_changed',
          node,
          actor: owner,
          owner,
          manager: controller,
          resolver,
          expiresAt: '2999-06-17T00:00:00.000Z',
        },
        meta: { txId: 'tx-owner', blockHeight: 2 },
      },
      {
        event: {
          type: 'record_changed',
          node,
          controller,
          record: {
            key: 'moonlight_address',
            value: 'dusk1localresolverproof01',
            visibility: 'public',
            updatedAt: recordUpdatedAt,
            ttlSeconds: 300,
          },
        },
        meta: { txId: 'tx-record', blockHeight: 3 },
      },
      {
        event: {
          type: 'primary_name_changed',
          endpoint: {
            type: 'moonlight_address',
            value: 'dusk1localresolverproof01',
          },
          controller,
          node,
          name: 'aurora.dusk',
          previousName: null,
          updatedAt: primaryUpdatedAt,
        },
        meta: { txId: 'tx-primary', blockHeight: 4 },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      const response = await expectJson(`${baseUrl}/resolve?name=aurora.dusk`)
      expect(response.warnings.map((warning) => warning.code)).toEqual([
        'recent_high_risk_record_change',
        'recent_primary_name_change',
      ])
      expect(response.warnings).toMatchObject([
        { target: 'moonlight_address', txId: 'tx-record', blockHeight: 3 },
        { target: 'moonlight_address:dusk1localresolverproof01', txId: 'tx-primary', blockHeight: 4 },
      ])
    } finally {
      await close()
    }
  })

  it('matches names owner filters against event-log resolver and reverse controllers', async () => {
    const eventLogFile = await writeEventLog(createEventLog({
      controller: '0xrecord-controller',
    }))
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/names?owner=0xrecord-controller`)).resolves.toMatchObject([{
        canonicalName: 'aurora.dusk',
        owner: '0xowner',
      }])
    } finally {
      await close()
    }
  })

  it('does not expose Phoenix endpoint events as public primary-name identities', async () => {
    const eventLogFile = await writeEventLog([{
      event: {
        type: 'primary_name_changed',
        endpoint: {
          type: 'phoenix_payment_endpoint',
          value: 'phoenix:private-payment',
        },
        controller: '0xowner',
        node: `0x${'aa'.repeat(32)}`,
        name: 'aurora.dusk',
        previousName: null,
        updatedAt: '2026-06-17T00:00:00.000Z',
      },
      meta: { txId: 'tx-phoenix', blockHeight: 40 },
    }])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/reverse?type=phoenix_payment_endpoint&value=phoenix%3Aprivate-payment`)).resolves.toBeNull()
    } finally {
      await close()
    }
  })
})
