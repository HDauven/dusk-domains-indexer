import { rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadEventLogStore,
  loadSqliteStore,
} from '../server/local-indexer.mjs'
import {
  closeServer,
  expectedLocalIndexerRoutes,
  expectJson,
  startIndexer as startIndexerFixture,
  writeEventLog as writeEventLogFixture,
} from './test-fixtures/local-indexer-server.mjs'

const tempDirs = []
const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeEventLog(options = {}) {
  return writeEventLogFixture(options, { trackTempDir: (dir) => tempDirs.push(dir) })
}

async function startIndexer(store, handlerOptions = {}) {
  return startIndexerFixture(store, {
    handlerOptions,
    trackServer: (server) => servers.push(server),
  })
}

describe('local indexer event-log HTTP API', () => {
  it('serves the same read contract from replayed event-log state', async () => {
    const fixture = await writeEventLog()
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
      ok: true,
      apiVersion: 'v1',
      eventSchemaVersion: '1',
      readModelSchemaVersion: 1,
      mode: 'event-log',
      routes: expectedLocalIndexerRoutes,
      names: 1,
      cursor: {
        status: 'running',
        eventCount: 5,
      },
      checkpoint: {
        status: 'replayed',
        eventCount: 6,
        rawEventCount: 6,
        duplicateCount: 0,
        warningCount: 0,
        lastEventName: 'subname_created',
        lastTxId: 'tx-subname',
        lastBlockHeight: 6,
      },
    })
    await expect(expectJson(`${baseUrl}/search?query=aurora`)).resolves.toMatchObject({
      status: 'registered',
    })
    await expect(expectJson(`${baseUrl}/resolve?name=aurora`)).resolves.toMatchObject({
      canonicalName: 'aurora.dusk',
      node: fixture.node,
      verificationStatus: 'forward_resolved',
      records: [{
        key: 'moonlight_address',
        value: fixture.moonlight,
      }],
    })
    await expect(expectJson(`${baseUrl}/names?owner=${fixture.owner}`)).resolves.toMatchObject([{
      canonicalName: 'aurora.dusk',
      primaryName: 'aurora.dusk',
      primaryStatus: 'verified',
      subnameCount: 1,
      activityCount: 5,
    }])
    await expect(expectJson(`${baseUrl}/names?owner=${fixture.controller}`)).resolves.toMatchObject([{
      canonicalName: 'aurora.dusk',
    }])
    await expect(expectJson(`${baseUrl}/activity?node=${fixture.node}`)).resolves.toMatchObject([
      { eventType: 'subname_created' },
      { eventType: 'primary_name' },
      { eventType: 'record_update' },
      { eventType: 'transfer' },
      { eventType: 'registration' },
    ])
    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${fixture.moonlight}`)).resolves.toMatchObject({
      primaryName: 'aurora.dusk',
      node: fixture.node,
    })
    await expect(expectJson(`${baseUrl}/reverse?type=phoenix_payment_endpoint&value=${fixture.phoenix}`)).resolves.toBeNull()
    await expect(expectJson(`${baseUrl}/subnames?parentNode=${fixture.node}`)).resolves.toMatchObject([{
      name: 'settlement.aurora.dusk',
      status: 'active',
    }])
  })

  it('serves the same read contract from a SQLite durable event store', async () => {
    const fixture = await writeEventLog({ referralEvents: true })
    const dbFile = join(dirname(fixture.eventLogFile), 'indexer.sqlite')
    await writeFile(fixture.cursorFile, JSON.stringify({
      version: 1,
      source: 'test-collector',
      status: 'running',
      eventCount: 9,
      replayedEventCount: 9,
      startedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:08:00.000Z',
      lastEventAt: '2026-06-18T00:08:00.000Z',
      lastContract: 'treasury',
      lastEventName: 'referral_reward_claimed',
      lastTxId: 'tx-referral-claim',
      lastBlockHeight: 8,
      currentBlockHeight: 8,
      scannedBlockHeight: 8,
    }), 'utf8')
    const store = await loadSqliteStore(dbFile, {
      eventLogFile: fixture.eventLogFile,
      cursorFile: fixture.cursorFile,
      strictHealth: true,
    })
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
      ok: true,
      source: 'local-indexer-sqlite',
      mode: 'sqlite',
      sqlite: {
        schemaVersion: 1,
        expectedSchemaVersion: 1,
        migrations: [
          expect.objectContaining({
            version: 1,
            name: 'initial_event_ledger',
          }),
        ],
      },
      routes: expectedLocalIndexerRoutes,
      names: 1,
      cursor: {
        status: 'running',
      },
      checkpoint: {
        source: 'local-indexer-sqlite',
        status: 'replayed',
        eventCount: 9,
        rawEventCount: 9,
        duplicateCount: 0,
        warningCount: 0,
        lastEventName: 'referral_reward_claimed',
        lastTxId: 'tx-referral-claim',
        lastBlockHeight: 8,
      },
      durability: {
        ok: true,
        code: 'durable_indexer_ready',
      },
    })
    await expect(expectJson(`${baseUrl}/search?query=aurora`)).resolves.toMatchObject({
      canonical: 'aurora.dusk',
      status: 'registered',
    })
    await expect(expectJson(`${baseUrl}/resolve?name=aurora`)).resolves.toMatchObject({
      canonicalName: 'aurora.dusk',
      node: fixture.node,
      verificationStatus: 'forward_resolved',
      records: [{
        key: 'moonlight_address',
        value: fixture.moonlight,
      }],
    })
    await expect(expectJson(`${baseUrl}/names?owner=${fixture.owner}`)).resolves.toMatchObject([{
      canonicalName: 'aurora.dusk',
      primaryName: 'aurora.dusk',
      primaryStatus: 'verified',
      subnameCount: 1,
    }])
    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${fixture.moonlight}`)).resolves.toMatchObject({
      primaryName: 'aurora.dusk',
      node: fixture.node,
    })
    await expect(expectJson(`${baseUrl}/referrals?referrer=${fixture.owner}`)).resolves.toMatchObject({
      supported: true,
      claimableLux: 4_000_000_000,
      claimedLux: 3_000_000_000,
      referralCount: 2,
    })
    await expect(expectJson(`${baseUrl}/reverse?type=phoenix_payment_endpoint&value=${fixture.phoenix}`)).resolves.toBeNull()
  })

  it('keeps non-primary endpoint event-log reverse records out of public primary lookup', async () => {
    const fixture = await writeEventLog({ contractReverse: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${fixture.moonlight}`)).resolves.toMatchObject({
      primaryName: 'aurora.dusk',
      node: fixture.node,
    })
    await expect(expectJson(`${baseUrl}/reverse?type=dusk_contract&value=${fixture.subnameContract}`)).resolves.toBeNull()
  })

  it('serves referral rewards from replayed event-log state', async () => {
    const fixture = await writeEventLog({ referralEvents: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/referrals?referrer=${fixture.owner}`)).resolves.toMatchObject({
      supported: true,
      referrer: fixture.owner,
      claimableLux: 4_000_000_000,
      claimedLux: 3_000_000_000,
      referralCount: 2,
      recentActivity: [
        {
          kind: 'claim',
          amountLux: 3_000_000_000,
          txId: 'tx-referral-claim',
          blockHeight: 8,
        },
        {
          kind: 'accrual',
          amountLux: 2_000_000_000,
          txId: 'tx-referral-accrual-2',
          blockHeight: 7,
          counterparty: fixture.controller,
        },
        {
          kind: 'accrual',
          amountLux: 5_000_000_000,
          txId: 'tx-referral-accrual-1',
          blockHeight: 7,
          counterparty: fixture.controller,
        },
      ],
    })
    await expect(expectJson(`${baseUrl}/referrals?referrer=0x${'99'.repeat(32)}`)).resolves.toMatchObject({
      supported: true,
      referrer: `0x${'99'.repeat(32)}`,
      claimableLux: 0,
      claimedLux: 0,
      referralCount: 0,
      recentActivity: [],
    })
  })

  it('marks referral rewards supported after treasury initialization even before rewards accrue', async () => {
    const fixture = await writeEventLog({ treasuryEvents: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/referrals?referrer=0x${'99'.repeat(32)}`)).resolves.toMatchObject({
      supported: true,
      referrer: `0x${'99'.repeat(32)}`,
      claimableLux: 0,
      claimedLux: 0,
      referralCount: 0,
      recentActivity: [],
    })
  })

  it('does not verify My Names against stale reverse records after address rotation', async () => {
    const fixture = await writeEventLog({ rotateMoonlightRecord: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/resolve?name=aurora`)).resolves.toMatchObject({
      canonicalName: 'aurora.dusk',
      records: [{
        key: 'moonlight_address',
        value: fixture.rotatedMoonlight,
      }],
    })
    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${fixture.moonlight}`)).resolves.toMatchObject({
      primaryName: 'aurora.dusk',
    })
    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${fixture.rotatedMoonlight}`)).resolves.toBeNull()
    await expect(expectJson(`${baseUrl}/names?owner=${fixture.owner}`)).resolves.toMatchObject([{
      canonicalName: 'aurora.dusk',
      primaryName: null,
      primaryStatus: 'missing',
      records: [{
        key: 'moonlight_address',
        value: fixture.rotatedMoonlight,
      }],
    }])
  })

  it('does not verify My Names when reverse points the endpoint at another node', async () => {
    const fixture = await writeEventLog({ reverseWrongNode: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${fixture.moonlight}`)).resolves.toMatchObject({
      primaryName: 'aurora.dusk',
    })
    await expect(expectJson(`${baseUrl}/names?owner=${fixture.owner}`)).resolves.toMatchObject([{
      canonicalName: 'aurora.dusk',
      primaryName: 'aurora.dusk',
      primaryStatus: 'mismatch',
    }])
  })

  it('keeps released names and subnames out of active routes while preserving activity history', async () => {
    const fixture = await writeEventLog({ release: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
      ok: true,
      mode: 'event-log',
      names: 0,
    })
    await expect(expectJson(`${baseUrl}/search?query=aurora`)).resolves.toMatchObject({
      canonical: 'aurora.dusk',
      status: 'available',
      transactionBlocked: false,
    })
    await expect(expectJson(`${baseUrl}/resolve?name=aurora`)).resolves.toMatchObject({
      canonicalName: 'aurora.dusk',
      verificationStatus: 'unverified',
      records: [],
      resolver: {
        health: 'missing',
      },
    })
    await expect(expectJson(`${baseUrl}/names?owner=${fixture.owner}`)).resolves.toEqual([])
    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${fixture.moonlight}`)).resolves.toBeNull()
    await expect(expectJson(`${baseUrl}/subnames?parentNode=${fixture.node}`)).resolves.toEqual([])

    await expect(expectJson(`${baseUrl}/name?node=${fixture.node}`)).resolves.toMatchObject({
      canonicalName: 'aurora.dusk',
      status: 'released',
      owner: null,
      resolverId: null,
    })
    const activity = await expectJson(`${baseUrl}/activity?node=${fixture.node}`)
    expect(activity[0]).toMatchObject({ eventType: 'release' })
    expect(activity.map((entry) => entry.eventType)).toContain('registration')
    await expect(expectJson(`${baseUrl}/subname?node=${fixture.subnode}`)).resolves.toBeNull()
  })

  it('excludes revoked event-log subnames from active parent lists and summaries', async () => {
    const fixture = await writeEventLog({ revokeSubname: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/subnames?parentNode=${fixture.node}`)).resolves.toEqual([])
    await expect(expectJson(`${baseUrl}/names?owner=${fixture.owner}`)).resolves.toMatchObject([{
      canonicalName: 'aurora.dusk',
      subnameCount: 0,
    }])
    await expect(expectJson(`${baseUrl}/subname?node=${fixture.subnode}`)).resolves.toBeNull()
  })

  it('resolves subnames with their own indexed resolver records', async () => {
    const fixture = await writeEventLog({ subnameRecord: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/resolve?name=aurora`)).resolves.toMatchObject({
      canonicalName: 'aurora.dusk',
      node: fixture.node,
      records: [{
        key: 'moonlight_address',
        value: fixture.moonlight,
      }],
    })
    await expect(expectJson(`${baseUrl}/resolve?name=settlement.aurora`)).resolves.toMatchObject({
      canonicalName: 'settlement.aurora.dusk',
      node: fixture.subnode,
      verificationStatus: 'forward_resolved',
      records: [{
        key: 'dusk_contract',
        value: fixture.subnameContract,
      }],
    })
    const subname = await expectJson(`${baseUrl}/subname?node=${fixture.subnode}`)
    expect(subname).toMatchObject({
      name: 'settlement.aurora.dusk',
      status: 'active',
    })
    expect(subname.records).toBeUndefined()
  })
})
