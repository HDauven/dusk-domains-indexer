import { describe, expect, it } from 'vitest'
import {
  dedupeEventLogEntries,
  healthResponseForStore,
  loadEventLogStore,
} from './local-indexer.mjs'
import {
  createEventLog,
  expectJson,
  startServer,
  writeCursor,
  writeEventLog,
} from './local-indexer-test-helpers.mjs'

describe('local indexer event-log API', () => {
  it('exposes a first-class degraded health reason while preserving warnings', () => {
    expect(healthResponseForStore({
      generatedAt: '2026-06-28T12:00:00.000Z',
      source: 'fixture',
      mode: 'degraded',
      namesByCanonical: new Map(),
      warnings: [{
        code: 'invalid_event_log_row',
        message: 'Skipped malformed row.',
      }],
      health: {
        ok: false,
        code: 'collector_cursor_stale',
        message: 'Collector cursor is stale.',
      },
    })).toMatchObject({
      ok: false,
      mode: 'degraded',
      names: 0,
      degradedReason: {
        code: 'collector_cursor_stale',
        message: 'Collector cursor is stale.',
      },
      warnings: [
        {
          code: 'invalid_event_log_row',
          message: 'Skipped malformed row.',
        },
        {
          code: 'collector_cursor_stale',
          message: 'Collector cursor is stale.',
        },
      ],
    })
  })

  it('replays an append-only event log into the same local-live API routes', async () => {
    const eventLogFile = await writeEventLog(createEventLog())
    const cursorFile = await writeCursor({
      status: 'running',
      eventCount: 5,
      replayedEventCount: 5,
      lastContract: 'reverse',
      lastEventName: 'primary_name_changed',
      lastEventAt: '2026-06-17T00:00:01.000Z',
      lastTxId: 'tx-reverse',
      lastBlockHeight: 42,
    })
    const store = await loadEventLogStore(eventLogFile, cursorFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
        ok: true,
        source: 'local-indexer-event-log',
        mode: 'event-log',
        names: 1,
        checkpoint: {
          status: 'replayed',
          eventCount: 5,
          rawEventCount: 5,
          duplicateCount: 0,
          warningCount: 0,
          lastEventName: 'subname_created',
          lastTxId: 'tx-subname',
          lastBlockHeight: 14,
        },
        cursor: {
          status: 'running',
          eventCount: 5,
          replayedEventCount: 5,
          lastContract: 'reverse',
          lastEventName: 'primary_name_changed',
          lastTxId: 'tx-reverse',
          lastBlockHeight: 42,
        },
      })
      await expect(expectJson(`${baseUrl}/search?query=aurora`)).resolves.toMatchObject({
        canonical: 'aurora.dusk',
        status: 'registered',
      })
      await expect(expectJson(`${baseUrl}/resolve?name=aurora.dusk`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        verificationStatus: 'forward_resolved',
        resolver: {
          resolverId: `0x${'cc'.repeat(32)}`,
          health: 'ok',
        },
        records: [{ key: 'moonlight_address', value: 'dusk1localresolverproof01' }],
      })
      await expect(expectJson(`${baseUrl}/records?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toMatchObject([
        { key: 'moonlight_address', value: 'dusk1localresolverproof01' },
      ])
      await expect(expectJson(`${baseUrl}/record?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&key=moonlight_address`)).resolves.toMatchObject({
        key: 'moonlight_address',
        value: 'dusk1localresolverproof01',
      })
      await expect(expectJson(`${baseUrl}/record-history?node=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&key=moonlight_address`)).resolves.toMatchObject([{
        action: 'set',
        key: 'moonlight_address',
        txId: 'tx-record',
        blockHeight: 12,
        eventType: 'record_changed',
      }])
      await expect(expectJson(`${baseUrl}/names?owner=0xowner`)).resolves.toMatchObject([{
        canonicalName: 'aurora.dusk',
        primaryName: 'aurora.dusk',
        primaryStatus: 'verified',
        records: [{ key: 'moonlight_address' }],
        subnameCount: 1,
        activityCount: 5,
      }])
      await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=dusk1localresolverproof01`)).resolves.toMatchObject({
        primaryName: 'aurora.dusk',
      })
      await expect(expectJson(`${baseUrl}/subnames?parentNode=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).resolves.toMatchObject([{
        name: 'settlement.aurora.dusk',
      }])
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
    } finally {
      await close()
    }
  })

  it('indexes marketplace auction state from event logs', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const sellerAuthority = `0x${'11'.repeat(32)}`
    const marketplaceContractId = `0x${'99'.repeat(32)}`
    const eventLogFile = await writeEventLog([
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: sellerAuthority,
          owner: sellerAuthority,
          expiresAt: '2027-06-17T00:00:00.000Z',
          graceEndsAt: '2027-07-17T00:00:00.000Z',
          feeLux: 10_000_000_000,
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'domain_auction_created',
          node,
          name: 'aurora.dusk',
          sellerAuthority,
          reservePriceLux: 40_000_000_000,
          durationBlocks: 8_640,
          startDeadlineBlockHeight: 20_000,
          feeBps: 250,
          createdAtBlockHeight: 2,
        },
        meta: { txId: 'tx-auction', blockHeight: 2, contractId: marketplaceContractId },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/marketplace/auctions`)).resolves.toMatchObject([{
        node,
        name: 'aurora.dusk',
        sellerAuthority,
        marketplaceContractId,
        escrowed: false,
        reservePriceLux: 40_000_000_000,
        durationBlocks: 8_640,
        startDeadlineBlockHeight: 20_000,
        endBlockHeight: null,
        highestBid: null,
        bidCount: 0,
      }])
      await expect(expectJson(`${baseUrl}/marketplace/auction?node=${node}`)).resolves.toMatchObject({
        node,
        name: 'aurora.dusk',
        marketplaceContractId,
        escrowed: false,
        reservePriceLux: 40_000_000_000,
      })
      await expect(expectJson(`${baseUrl}/activity?node=${node}`)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'domain_auction_created',
            txId: 'tx-auction',
          }),
        ]),
      )
    } finally {
      await close()
    }
  })

  it('rejects unsafe marketplace amounts instead of indexing rounded values', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const eventLogFile = await writeEventLog([{
      event: {
        type: 'domain_offer_placed',
        node,
        buyerAuthority: `0x${'11'.repeat(32)}`,
        amountLux: 9_007_199_254_740_992,
        feeBps: 250,
        expiresAtBlockHeight: 100,
        placedAtBlockHeight: 2,
      },
      meta: { txId: 'tx-unsafe', blockHeight: 2 },
    }])

    const store = await loadEventLogStore(eventLogFile)
    expect(store.marketplaceOffersByKey.size).toBe(0)
    expect(store.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'invalid_event_log_event',
        message: expect.stringContaining('unsafe numeric value'),
      }),
    ]))

    const strictStore = await loadEventLogStore(eventLogFile, null, { strictHealth: true })
    expect(strictStore.durability.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'replay_warnings',
        ok: false,
      }),
    ]))
    expect(healthResponseForStore(strictStore).ok).toBe(false)
  })

  it('marks marketplace auctions escrowed only after domain authority moves to the marketplace', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const sellerAuthority = `0x${'11'.repeat(32)}`
    const marketplaceContractId = `0x${'99'.repeat(32)}`
    const eventLogFile = await writeEventLog([
      {
        event: {
          type: 'name_registered',
          node,
          label: 'aurora',
          actor: sellerAuthority,
          owner: sellerAuthority,
          expiresAt: '2027-06-17T00:00:00.000Z',
          graceEndsAt: '2027-07-17T00:00:00.000Z',
          feeLux: 10_000_000_000,
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'domain_auction_created',
          node,
          name: 'aurora.dusk',
          sellerAuthority,
          reservePriceLux: 25_000_000_000,
          durationBlocks: 8_640,
          startDeadlineBlockHeight: 20_000,
          feeBps: 250,
          createdAtBlockHeight: 2,
        },
        meta: { txId: 'tx-auction', blockHeight: 2, contractId: marketplaceContractId },
      },
      {
        event: {
          type: 'name_owner_changed',
          node,
          actor: sellerAuthority,
          owner: marketplaceContractId,
          manager: marketplaceContractId,
          resolver: marketplaceContractId,
          expiresAt: '2027-06-17T00:00:00.000Z',
          expiresAtBlockHeight: 500_000,
        },
        meta: { txId: 'tx-escrowed', blockHeight: 3, contractId: node },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/marketplace/auction?node=${node}`)).resolves.toMatchObject({
        node,
        name: 'aurora.dusk',
        marketplaceContractId,
        escrowed: true,
      })
    } finally {
      await close()
    }
  })

  it('serves fixed sales, offers, config and aggregate pull refunds', async () => {
    const node = `0x${'ab'.repeat(32)}`
    const sellerAuthority = `0x${'11'.repeat(32)}`
    const buyerAuthority = `0x${'22'.repeat(32)}`
    const marketplaceContractId = `0x${'99'.repeat(32)}`
    const eventLogFile = await writeEventLog([
      {
        event: {
          type: 'marketplace_initialized',
          coreContract: `0x${'01'.repeat(32)}`,
          treasuryContract: `0x${'02'.repeat(32)}`,
          marketplaceAuthority: marketplaceContractId,
          operator: sellerAuthority,
          feeBps: 250,
        },
        meta: { txId: 'tx-init', blockHeight: 1, contractId: marketplaceContractId },
      },
      {
        event: {
          type: 'domain_fixed_sale_opened',
          node,
          name: 'market.dusk',
          sellerAuthority,
          priceLux: 25_000_000_000,
          privateBuyer: null,
          feeBps: 250,
          expiresAtBlockHeight: 10_000,
          openedAtBlockHeight: 2,
        },
        meta: { txId: 'tx-sale', blockHeight: 2, contractId: marketplaceContractId },
      },
      {
        event: {
          type: 'domain_offer_placed',
          node,
          buyerAuthority,
          amountLux: 20_000_000_000,
          feeBps: 250,
          expiresAtBlockHeight: 8_000,
          placedAtBlockHeight: 3,
        },
        meta: { txId: 'tx-offer', blockHeight: 3, contractId: marketplaceContractId },
      },
      {
        event: {
          type: 'domain_offer_closed',
          node,
          buyerAuthority,
          amountLux: 20_000_000_000,
          expired: false,
          closedAtBlockHeight: 4,
        },
        meta: { txId: 'tx-offer-close', blockHeight: 4, contractId: marketplaceContractId },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/marketplace/config`)).resolves.toMatchObject({
        initialized: true,
        feeBps: 250,
      })
      await expect(expectJson(`${baseUrl}/marketplace/fixed-sales`)).resolves.toMatchObject([{
        node,
        priceLux: 25_000_000_000,
      }])
      await expect(expectJson(`${baseUrl}/marketplace/fixed-sale?node=${node}`)).resolves.toMatchObject({ node })
      await expect(expectJson(`${baseUrl}/marketplace/offers?node=${node}`)).resolves.toEqual([])
      await expect(expectJson(`${baseUrl}/marketplace/refund?authority=${buyerAuthority}`)).resolves.toMatchObject({
        authority: buyerAuthority,
        amountLux: 20_000_000_000,
      })
    } finally {
      await close()
    }
  })

  it('tracks bids and removes marketplace auctions after settlement', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const sellerAuthority = `0x${'11'.repeat(32)}`
    const created = {
      event: {
        type: 'domain_auction_created',
        node,
        name: 'aurora.dusk',
        sellerAuthority,
        reservePriceLux: 25_000_000_000,
        durationBlocks: 8_640,
        startDeadlineBlockHeight: 20_000,
        feeBps: 250,
        createdAtBlockHeight: 2,
      },
      meta: { txId: 'tx-auction', blockHeight: 2 },
    }
    const eventLogFile = await writeEventLog([
      created,
      {
        event: {
          type: 'domain_bid_placed',
          node,
          bidderAuthority: `0x${'22'.repeat(32)}`,
          amountLux: 25_000_000_000,
          previousBidderAuthority: null,
          previousBidLux: 0,
          startBlock: 3,
          endBlock: 1_000,
          started: true,
          extended: false,
          bidCount: 1,
          placedAtBlockHeight: 3,
        },
        meta: { txId: 'tx-bid', blockHeight: 3 },
      },
      {
        event: {
          type: 'domain_auction_settled',
          node,
          name: 'aurora.dusk',
          sellerAuthority,
          winnerAuthority: `0x${'22'.repeat(32)}`,
          grossAmountLux: 25_000_000_000,
          protocolFeeLux: 625_000_000,
          sellerProceedsLux: 24_375_000_000,
          domainExpired: false,
          settledAtBlockHeight: 4,
        },
        meta: { txId: 'tx-settled', blockHeight: 4 },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/marketplace/auctions`)).resolves.toEqual([])
      await expect(expectJson(`${baseUrl}/marketplace/auction?node=${node}`)).resolves.toBe(null)
      await expect(expectJson(`${baseUrl}/activity?node=${node}`)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'domain_auction_settled',
            txId: 'tx-settled',
          }),
        ]),
      )
    } finally {
      await close()
    }
  })

  it('exposes package, schema and deployment binding metadata in health', async () => {
    const coreContract = `0x${'11'.repeat(32)}`
    const treasuryContract = `0x${'22'.repeat(32)}`
    const eventLogFile = await writeEventLog([
      {
        event: {
          type: 'name_registered',
          node: `0x${'aa'.repeat(32)}`,
          label: 'aurora',
          actor: '0xowner',
          owner: '0xowner',
          expiresAt: '2027-06-17T00:00:00.000Z',
          graceEndsAt: '2027-07-17T00:00:00.000Z',
          feeLux: 10,
        },
        meta: {
          chainId: 'dusk:2',
          contractKey: 'core',
          contractId: coreContract,
          txId: 'tx-register',
          blockHeight: 100,
        },
      },
      {
        event: {
          type: 'treasury_initialized',
          operator: '0xoperator',
          operatorRecipient: 'dusk1operator',
          allowedFeeSources: [coreContract],
        },
        meta: {
          chainId: 'dusk:2',
          contractKey: 'treasury',
          contractId: treasuryContract,
          txId: 'tx-treasury',
          blockHeight: 101,
        },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
        ok: true,
        apiVersion: 'v1',
        schemaVersion: 1,
        eventSchemaVersion: '1',
        readModelSchemaVersion: 1,
        package: {
          name: '@hdauven/dusk-domains-indexer',
          sdk: {
            package: '@duskdomains/sdk',
          },
        },
        deployment: {
          chainId: 'dusk:2',
          deploymentStartHeight: 100,
          lastEventBlockHeight: 101,
          complete: true,
          contracts: {
            core: {
              contractId: coreContract,
              eventCount: 1,
            },
            treasury: {
              contractId: treasuryContract,
              eventCount: 1,
            },
          },
        },
      })
    } finally {
      await close()
    }
  })

  it('serves finalized commitment block state from replayed controller events', async () => {
    const commitment = `0x${'aa'.repeat(32)}`
    const node = `0x${'bb'.repeat(32)}`
    const controller = `0x${'cc'.repeat(32)}`
    const eventLogFile = await writeEventLog([
      {
        event: {
          type: 'registration_committed',
          commitment,
          controller,
          createdAt: '2026-06-19T12:00:00.000Z',
        },
        meta: { txId: 'tx-commit', blockHeight: 100 },
      },
      {
        event: {
          type: 'registration_revealed',
          commitment,
          node,
          controller,
        },
        meta: { txId: 'tx-reveal', blockHeight: 105 },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/commitment?commitment=${commitment}`)).resolves.toMatchObject({
        commitment,
        controller,
        node,
        status: 'revealed',
        committedTxId: 'tx-commit',
        committedBlockHeight: 100,
        revealedTxId: 'tx-reveal',
        revealedBlockHeight: 105,
      })
    } finally {
      await close()
    }
  })

  it('preserves lifecycle block heights from replayed renewal events', async () => {
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
          expiresAtBlockHeight: 1_000,
          graceEndsAtBlockHeight: 1_100,
          feeLux: 10,
        },
        meta: { txId: 'tx-register', blockHeight: 1 },
      },
      {
        event: {
          type: 'name_renewed',
          node,
          actor: owner,
          expiresAt: '2028-06-17T00:00:00.000Z',
          graceEndsAt: '2028-07-17T00:00:00.000Z',
          expiresAtBlockHeight: 2_000,
          graceEndsAtBlockHeight: 2_100,
          feeLux: 10,
        },
        meta: { txId: 'tx-renew', blockHeight: 2 },
      },
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/name?node=${node}`)).resolves.toMatchObject({
        canonicalName: 'aurora.dusk',
        expiresAt: '2028-06-17T00:00:00.000Z',
        graceEndsAt: '2028-07-17T00:00:00.000Z',
        expiresAtBlockHeight: 2_000,
        graceEndsAtBlockHeight: 2_100,
      })
      await expect(expectJson(`${baseUrl}/names?owner=${owner}`)).resolves.toMatchObject([{
        canonicalName: 'aurora.dusk',
        expiresAtBlockHeight: 2_000,
        graceEndsAtBlockHeight: 2_100,
      }])
    } finally {
      await close()
    }
  })

  it('dedupes repeated event-log rows without dropping distinct later updates', async () => {
    const node = `0x${'aa'.repeat(32)}`
    const owner = '0xowner'
    const manager = '0xmanager'
    const firstMoonlight = 'dusk1localresolverproof01'
    const secondMoonlight = 'dusk1localresolverproof02'
    const registered = {
      event: {
        type: 'name_registered',
        node,
        label: 'aurora',
        actor: owner,
        owner,
        expiresAt: '2027-06-17T00:00:00.000Z',
        graceEndsAt: '2027-07-17T00:00:00.000Z',
      },
      meta: {
        txId: 'tx-register',
        blockHeight: 1,
        observedAt: '2026-06-17T00:00:00.000Z',
        contractKey: 'registrar',
      },
    }
    const ownerChanged = {
      event: {
        type: 'name_owner_changed',
        node,
        actor: owner,
        owner,
        manager,
        resolver: `0x${'cc'.repeat(32)}`,
        expiresAt: '2027-06-17T00:00:00.000Z',
      },
      meta: {
        txId: 'tx-owner',
        blockHeight: 2,
        observedAt: '2026-06-17T00:00:01.000Z',
        contractKey: 'registry',
      },
    }
    const firstRecord = {
      event: {
        type: 'record_changed',
        node,
        controller: manager,
        record: {
          key: 'moonlight_address',
          value: firstMoonlight,
          ttlSeconds: 180,
          updatedAt: '2026-06-17T00:01:00.000Z',
          visibility: 'public',
        },
      },
      meta: {
        txId: 'tx-record-1',
        blockHeight: 3,
        observedAt: '2026-06-17T00:01:01.000Z',
        contractKey: 'resolver',
      },
    }
    const firstRecordDuplicate = {
      ...firstRecord,
      meta: {
        ...firstRecord.meta,
        observedAt: '2026-06-17T00:01:02.000Z',
      },
    }
    const secondRecord = {
      event: {
        ...firstRecord.event,
        record: {
          ...firstRecord.event.record,
          value: secondMoonlight,
          updatedAt: '2026-06-17T00:02:00.000Z',
        },
      },
      meta: {
        txId: 'tx-record-2',
        blockHeight: 4,
        observedAt: '2026-06-17T00:02:01.000Z',
        contractKey: 'resolver',
      },
    }

    expect(dedupeEventLogEntries([
      registered,
      registered,
      ownerChanged,
      firstRecord,
      firstRecordDuplicate,
      secondRecord,
    ])).toHaveLength(4)

    const eventLogFile = await writeEventLog([
      registered,
      registered,
      ownerChanged,
      firstRecord,
      firstRecordDuplicate,
      secondRecord,
      secondRecord,
    ])
    const store = await loadEventLogStore(eventLogFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
        ok: true,
        mode: 'event-log',
        names: 1,
        checkpoint: {
          status: 'replayed',
          eventCount: 4,
          rawEventCount: 7,
          duplicateCount: 3,
          warningCount: 0,
          lastEventName: 'record_changed',
          lastTxId: 'tx-record-2',
          lastBlockHeight: 4,
        },
      })
      await expect(expectJson(`${baseUrl}/resolve?name=aurora.dusk`)).resolves.toMatchObject({
        records: [{
          key: 'moonlight_address',
          value: secondMoonlight,
        }],
      })
      await expect(expectJson(`${baseUrl}/activity?node=${node}`)).resolves.toMatchObject([
        { eventType: 'record_update', target: 'moonlight_address', txId: 'tx-record-2' },
        { eventType: 'record_update', target: 'moonlight_address', txId: 'tx-record-1' },
        { eventType: 'transfer', txId: 'tx-owner' },
        { eventType: 'registration', txId: 'tx-register' },
      ])
    } finally {
      await close()
    }
  })

  it('keeps event-log routes alive when the collector cursor is unreadable', async () => {
    const eventLogFile = await writeEventLog(createEventLog())
    const cursorFile = await writeCursor('not json')
    const store = await loadEventLogStore(eventLogFile, cursorFile)
    const { baseUrl, close } = await startServer(store)

    try {
      await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
        ok: true,
        mode: 'event-log',
        names: 1,
        cursor: {
          status: 'unreadable',
          eventCount: 0,
        },
      })
      await expect(expectJson(`${baseUrl}/resolve?name=aurora.dusk`)).resolves.toMatchObject({
        verificationStatus: 'forward_resolved',
      })
    } finally {
      await close()
    }
  })
})
