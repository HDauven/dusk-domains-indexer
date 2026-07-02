import { describe, expect, it } from 'vitest'
import {
  createReloadingSnapshotStore,
  loadSnapshotStore,
} from './local-indexer.mjs'
import {
  createSnapshot,
  expectJson,
  expectedLocalIndexerRoutes,
  startServer,
  writeSnapshot,
} from './local-indexer-test-helpers.mjs'

describe('local indexer snapshot API', () => {
  it('serves the local-live read routes from an E2E snapshot', async () => {
    const snapshotFile = await writeSnapshot(createSnapshot({ owner: '0xowner' }))
    const store = await loadSnapshotStore(snapshotFile)
    const { baseUrl, close } = await startServer(store)

    try {
      const health = await expectJson(`${baseUrl}/health`)
      expect(health).toMatchObject({
        ok: true,
        source: 'local-rusk-private-e2e',
        mode: 'snapshot',
        names: 1,
      })
      expect(health.routes).toEqual(expectedLocalIndexerRoutes)
      await expect(expectJson(`${baseUrl}/search?query=aurora`)).resolves.toMatchObject({
        canonical: 'aurora.dusk',
        status: 'registered',
      })
      await expect(expectJson(`${baseUrl}/names`)).resolves.toMatchObject([{
        canonicalName: 'aurora.dusk',
        owner: '0xowner',
        primaryName: 'aurora.dusk',
        primaryStatus: 'verified',
        subnameCount: 1,
        activityCount: 1,
      }])
      await expect(expectJson(`${baseUrl}/names?owner=0xmissing`)).resolves.toEqual([])
      await expect(expectJson(`${baseUrl}/resolve?name=aurora.dusk`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        verificationStatus: 'forward_resolved',
        records: [{ key: 'moonlight_address', value: 'dusk1localresolverproof01' }],
      })
      await expect(expectJson(`${baseUrl}/records?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toMatchObject([
        { key: 'moonlight_address', value: 'dusk1localresolverproof01' },
      ])
      await expect(expectJson(`${baseUrl}/record?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&key=moonlight_address`)).resolves.toMatchObject({
        key: 'moonlight_address',
        value: 'dusk1localresolverproof01',
      })
      await expect(expectJson(`${baseUrl}/record?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&key=website`)).resolves.toBeNull()
      await expect(expectJson(`${baseUrl}/record-history?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toEqual([])
      await expect(expectJson(`${baseUrl}/name?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        owner: '0xowner',
      })
      await expect(expectJson(`${baseUrl}/activity?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toMatchObject([{
        eventType: 'registration',
      }])
      await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=dusk1localresolverproof01`)).resolves.toMatchObject({
        primaryName: 'aurora.dusk',
      })
      await expect(expectJson(`${baseUrl}/subnames?parentNode=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toMatchObject([{
        name: 'settlement.aurora.dusk',
      }])
      await expect(expectJson(`${baseUrl}/subname?node=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`)).resolves.toMatchObject({
        canonicalName: 'settlement.aurora.dusk',
        name: 'settlement.aurora.dusk',
      })
      await expect(expectJson(`${baseUrl}/search?query=settlement.aurora.dusk`)).resolves.toMatchObject({
        canonical: 'settlement.aurora.dusk',
        status: 'registered',
      })
      await expect(expectJson(`${baseUrl}/resolve?name=settlement.aurora.dusk`)).resolves.toMatchObject({
        canonicalName: 'settlement.aurora.dusk',
        node: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        verificationStatus: 'forward_resolved',
        resolver: {
          resolverId: `0x${'cc'.repeat(32)}`,
          health: 'ok',
        },
      })
      await expect(expectJson(`${baseUrl}/name?node=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`)).resolves.toMatchObject({
        canonicalName: 'settlement.aurora.dusk',
        owner: '0xowner',
        resolverId: `0x${'cc'.repeat(32)}`,
      })
      await expect(expectJson(`${baseUrl}/fee-config`)).resolves.toMatchObject({
        threeCharYearLux: 150_000_000_000,
        fourCharYearLux: 50_000_000_000,
        fivePlusYearLux: 10_000_000_000,
        referralRewardBps: 2_000,
        renewalReferralRewardBps: 1_000,
        premiumReferralRewardBps: 0,
        version: 1,
      })
    } finally {
      await close()
    }
  })

  it('reloads the snapshot on request when the snapshot file changes', async () => {
    const snapshotFile = await writeSnapshot(createSnapshot({ owner: '0xowner-a' }))
    const storeProvider = await createReloadingSnapshotStore(snapshotFile)
    const { baseUrl, close } = await startServer(storeProvider)

    try {
      await expect(expectJson(`${baseUrl}/names`)).resolves.toMatchObject([{ owner: '0xowner-a' }])
      await writeSnapshot(createSnapshot({ owner: '0xowner-longer-b' }), snapshotFile)
      await expect(expectJson(`${baseUrl}/names`)).resolves.toMatchObject([{ owner: '0xowner-longer-b' }])
    } finally {
      await close()
    }
  })

  it('matches names owner filters against snapshot controller activity', async () => {
    const snapshotFile = await writeSnapshot(createSnapshot({
      owner: '0xowner',
      controller: '0xrecord-controller',
    }))
    const store = await loadSnapshotStore(snapshotFile)
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

  it('summarizes primary-name state in My Names responses', async () => {
    const owner = '0xowner'
    const cases = [
      {
        expected: { primaryName: 'aurora.dusk', primaryStatus: 'verified' },
        snapshot: createSnapshot({ owner }),
      },
      {
        expected: { primaryName: 'alice.dusk', primaryStatus: 'mismatch' },
        snapshot: createSnapshot({
          owner,
          reverse: [{
            endpoint: {
              type: 'moonlight_address',
              value: 'dusk1localresolverproof01',
            },
            primaryName: 'alice.dusk',
            node: `0x${'aa'.repeat(32)}`,
            controller: owner,
            updatedAt: '2026-06-17T00:00:00.000Z',
          }],
        }),
      },
      {
        expected: { primaryName: 'aurora.dusk', primaryStatus: 'mismatch' },
        snapshot: (() => {
          const snapshot = createSnapshot({
            owner,
            reverse: [{
              endpoint: {
                type: 'moonlight_address',
                value: 'dusk1localresolverproof01',
              },
              primaryName: 'aurora.dusk',
              node: `0x${'ab'.repeat(32)}`,
              controller: owner,
              updatedAt: '2026-06-17T00:00:00.000Z',
            }],
          })
          snapshot.names.push({
            ...snapshot.names[0],
            canonicalName: 'alice.dusk',
            node: `0x${'ab'.repeat(32)}`,
            owner: '0xother-owner',
            manager: '0xother-owner',
            records: [],
            activity: [],
          })
          return snapshot
        })(),
      },
      {
        expected: { primaryName: null, primaryStatus: 'missing' },
        snapshot: createSnapshot({ owner, reverse: [] }),
      },
      {
        expected: { primaryName: null, primaryStatus: 'no_address' },
        snapshot: createSnapshot({ owner, records: [] }),
      },
    ]

    for (const testCase of cases) {
      const snapshotFile = await writeSnapshot(testCase.snapshot)
      const store = await loadSnapshotStore(snapshotFile)
      const { baseUrl, close } = await startServer(store)

      try {
        await expect(expectJson(`${baseUrl}/names?owner=${owner}`)).resolves.toMatchObject([{
          canonicalName: 'aurora.dusk',
          ...testCase.expected,
        }])
      } finally {
        await close()
      }
    }
  })

  it('serves recent-change warnings from snapshot activity', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const recent = new Date(Date.now() - 60_000).toISOString()
    const snapshotFile = await writeSnapshot(createSnapshot({
      owner: '0xowner',
      activity: [{
        id: `record_update:${node}:0xcontroller:tx-record`,
        eventType: 'record_update',
        node,
        name: 'aurora.dusk',
        actor: '0xcontroller',
        target: 'moonlight_address',
        timestamp: recent,
        blockHeight: 44,
        txId: 'tx-record',
      }],
    }))
    const store = await loadSnapshotStore(snapshotFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/resolve?name=aurora.dusk`)).resolves.toMatchObject({
        warnings: [{
          code: 'recent_high_risk_record_change',
          eventType: 'record_update',
          target: 'moonlight_address',
          txId: 'tx-record',
          blockHeight: 44,
        }],
      })
    } finally {
      await close()
    }
  })

  it('fails closed for invalid snapshot resolver records', async () => {
    const snapshotFile = await writeSnapshot(createSnapshot({
      owner: '0xowner',
      records: [{
        key: 'website',
        value: 'http://insecure.example',
        visibility: 'public',
        updatedAt: '2026-06-17T00:00:00.000Z',
        ttlSeconds: 300,
      }, {
        key: 'dusk_asset',
        value: 'asset with spaces',
        visibility: 'public',
        updatedAt: '2026-06-17T00:00:00.000Z',
        ttlSeconds: 300,
      }],
    }))
    const store = await loadSnapshotStore(snapshotFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/resolve?name=aurora.dusk`)).resolves.toMatchObject({
        verificationStatus: 'unverified',
        resolver: {
          health: 'invalid',
        },
        errors: expect.arrayContaining([
          {
            code: 'invalid_record',
            message: expect.stringContaining('URLs must use HTTPS'),
          },
          {
            code: 'invalid_record',
            message: expect.stringContaining('Identifier must be 3-128 visible characters'),
          },
        ]),
      })
    } finally {
      await close()
    }
  })

  it('does not expose Phoenix snapshot reverse rows as public primary-name identities', async () => {
    const snapshotFile = await writeSnapshot(createSnapshot({
      owner: '0xowner',
      reverse: [
        {
          endpoint: {
            type: 'moonlight_address',
            value: 'dusk1localresolverproof01',
          },
          primaryName: 'aurora.dusk',
        },
        {
          endpoint: {
            type: 'phoenix_payment_endpoint',
            value: 'phoenix:private-payment',
          },
          primaryName: 'aurora.dusk',
        },
      ],
    }))
    const store = await loadSnapshotStore(snapshotFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=dusk1localresolverproof01`)).resolves.toMatchObject({
        primaryName: 'aurora.dusk',
      })
      await expect(expectJson(`${baseUrl}/reverse?type=phoenix_payment_endpoint&value=phoenix%3Aprivate-payment`)).resolves.toBeNull()
    } finally {
      await close()
    }
  })

  it('marks released and post-grace snapshot names available for registration search', async () => {
    const releasedSnapshotFile = await writeSnapshot(createSnapshot({
      owner: '0xowner',
      nameOverrides: {
        status: 'released',
        owner: null,
        manager: null,
        resolverId: null,
        lastEventType: 'name_released',
      },
    }))
    const postGraceSnapshotFile = await writeSnapshot(createSnapshot({
      owner: '0xowner',
      nameOverrides: {
        status: 'expired',
        expiresAt: '2020-01-01T00:00:00.000Z',
        graceEndsAt: '2020-02-01T00:00:00.000Z',
        lastEventType: 'name_expired',
      },
    }))

    const releasedStore = await loadSnapshotStore(releasedSnapshotFile)
    const postGraceStore = await loadSnapshotStore(postGraceSnapshotFile)
    const releasedServer = await startServer(releasedStore)
    const postGraceServer = await startServer(postGraceStore)

    try {
      await expect(expectJson(`${releasedServer.baseUrl}/search?query=aurora`)).resolves.toMatchObject({
        canonical: 'aurora.dusk',
        status: 'available',
        transactionBlocked: false,
      })
      await expect(expectJson(`${releasedServer.baseUrl}/name?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        status: 'released',
        owner: null,
      })
      await expect(expectJson(`${releasedServer.baseUrl}/resolve?name=aurora`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        records: [],
        resolver: {
          health: 'missing',
        },
        verificationStatus: 'unverified',
      })
      await expect(expectJson(`${releasedServer.baseUrl}/reverse?type=moonlight_address&value=dusk1localresolverproof01`)).resolves.toBeNull()
      await expect(expectJson(`${releasedServer.baseUrl}/names?owner=0xowner`)).resolves.toEqual([])
      await expect(expectJson(`${releasedServer.baseUrl}/subnames?parentNode=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toEqual([])
      await expect(expectJson(`${releasedServer.baseUrl}/subname?node=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`)).resolves.toBeNull()
      await expect(expectJson(`${postGraceServer.baseUrl}/search?query=aurora`)).resolves.toMatchObject({
        canonical: 'aurora.dusk',
        status: 'available',
        transactionBlocked: false,
      })
      await expect(expectJson(`${postGraceServer.baseUrl}/name?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        status: 'expired',
        owner: '0xowner',
      })
      await expect(expectJson(`${postGraceServer.baseUrl}/resolve?name=aurora`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        records: [],
        resolver: {
          health: 'missing',
        },
        verificationStatus: 'unverified',
      })
      await expect(expectJson(`${postGraceServer.baseUrl}/reverse?type=moonlight_address&value=dusk1localresolverproof01`)).resolves.toBeNull()
      await expect(expectJson(`${postGraceServer.baseUrl}/names?owner=0xowner`)).resolves.toEqual([])
      await expect(expectJson(`${postGraceServer.baseUrl}/subnames?parentNode=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toEqual([])
      await expect(expectJson(`${postGraceServer.baseUrl}/subname?node=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`)).resolves.toBeNull()
    } finally {
      await releasedServer.close()
      await postGraceServer.close()
    }
  })
})
