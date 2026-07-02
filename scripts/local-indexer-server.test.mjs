import { readFile, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createReloadingLocalIndexerStore,
  loadSnapshotStore,
} from '../server/local-indexer.mjs'
import {
  closeServer,
  expectedLocalIndexerRoutes,
  expectJson,
  startIndexer as startIndexerFixture,
  writeSnapshot as writeSnapshotFixture,
} from './test-fixtures/local-indexer-server.mjs'

const tempDirs = []
const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeSnapshot(options = {}) {
  return writeSnapshotFixture(options, { trackTempDir: (dir) => tempDirs.push(dir) })
}

async function startIndexer(store, handlerOptions = {}) {
  return startIndexerFixture(store, {
    handlerOptions,
    trackServer: (server) => servers.push(server),
  })
}

describe('local indexer HTTP API', () => {
  it('serves every local-live read route from a snapshot store', async () => {
    const snapshot = await writeSnapshot()
    const store = await loadSnapshotStore(snapshot.file)
    const { baseUrl } = await startIndexer(store)

    const health = await expectJson(`${baseUrl}/health`)
    expect(health).toMatchObject({
      ok: true,
      mode: 'snapshot',
      currentBlockHeight: 42,
      checkpoint: {
        lastBlockHeight: 42,
      },
      names: 2,
    })
    expect(health.routes).toEqual(expectedLocalIndexerRoutes)

    await expect(expectJson(`${baseUrl}/search?query=AURORA`)).resolves.toMatchObject({
      canonical: 'aurora.dusk',
      status: 'registered',
      transactionBlocked: true,
    })
    await expect(expectJson(`${baseUrl}/search?query=wallet`)).resolves.toMatchObject({
      canonical: 'wallet.dusk',
      status: 'reserved',
      reserved: {
        category: 'ecosystem',
      },
    })

    const resolved = await fetch(`${baseUrl}/resolve?name=AURORA`)
    expect(resolved.status).toBe(200)
    expect(resolved.headers.get('cache-control')).toBe('public, max-age=120')
    await expect(resolved.json()).resolves.toMatchObject({
      canonicalName: 'aurora.dusk',
      node: snapshot.node,
      verificationStatus: 'forward_resolved',
      records: [{
        key: 'moonlight_address',
        value: snapshot.moonlight,
      }],
    })

    await expect(expectJson(`${baseUrl}/name?node=${snapshot.node.slice(2)}`)).resolves.toMatchObject({
      node: snapshot.node,
      canonicalName: 'aurora.dusk',
      owner: snapshot.owner,
    })
    await expect(expectJson(`${baseUrl}/activity?node=${snapshot.node}`)).resolves.toMatchObject([{
      eventType: 'record_update',
      node: snapshot.node,
    }])
    await expect(expectJson(`${baseUrl}/subnames?parentNode=${snapshot.node}`)).resolves.toMatchObject([{
      node: snapshot.subnode,
      parentNode: snapshot.node,
      name: 'settlement.aurora.dusk',
    }])
    await expect(expectJson(`${baseUrl}/subname?node=${snapshot.subnode.slice(2)}`)).resolves.toMatchObject({
      node: snapshot.subnode,
      name: 'settlement.aurora.dusk',
    })
    await expect(expectJson(`${baseUrl}/names?owner=${snapshot.owner.toUpperCase()}`)).resolves.toMatchObject([{
      canonicalName: 'aurora.dusk',
      primaryName: 'aurora.dusk',
      primaryStatus: 'verified',
      records: [{
        key: 'moonlight_address',
      }],
      subnameCount: 1,
      activityCount: 1,
    }])
    await expect(expectJson(`${baseUrl}/names?owner=${snapshot.controller.toUpperCase()}`)).resolves.toMatchObject([{
      canonicalName: 'aurora.dusk',
    }])
    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${snapshot.moonlight}`)).resolves.toMatchObject({
      primaryName: 'aurora.dusk',
      name: 'aurora.dusk',
      node: snapshot.node,
    })
    await expect(expectJson(`${baseUrl}/treasury`)).resolves.toMatchObject({
      initialized: true,
      operatorAuthority: snapshot.owner,
      operatorRecipient: 'dusk1operator',
      allowedFeeSources: [snapshot.controller],
      totalReceivedLux: 70_000_000_000,
      availableLux: 35_000_000_000,
      registrationReceivedLux: 35_000_000_000,
      renewalReceivedLux: 35_000_000_000,
      otherReceivedLux: 0,
      lastFeeSourceContract: snapshot.controller,
      lastFeeReason: 'renewal',
      lastFeeNode: snapshot.node,
      claims: [{
        amountLux: 10_000_000_000,
        remainingLux: 35_000_000_000,
        txId: 'tx-claim',
        blockHeight: 43,
      }],
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
    await expect(expectJson(`${baseUrl}/referrals?referrer=${snapshot.owner}`)).resolves.toMatchObject({
      supported: true,
      referrer: snapshot.owner,
      claimableLux: 7_000_000_000,
      claimedLux: 3_000_000_000,
      referralCount: 2,
      recentActivity: [{
        kind: 'accrual',
        amountLux: 2_000_000_000,
        counterparty: snapshot.controller,
      }],
    })
    await expect(expectJson(`${baseUrl}/referrals?referrer=0x${'99'.repeat(32)}`)).resolves.toMatchObject({
      supported: true,
      referrer: `0x${'99'.repeat(32)}`,
      claimableLux: 0,
      claimedLux: 0,
      referralCount: 0,
    })
    await expect(expectJson(`${baseUrl}/reverse?type=phoenix_payment_endpoint&value=${encodeURIComponent(snapshot.phoenix)}`)).resolves.toBeNull()
    await expect(expectJson(`${baseUrl}/reverse?type=dusk_contract&value=${snapshot.contract}`)).resolves.toBeNull()
  })

  it('reloads watched stores only when backing files change', async () => {
    const snapshot = await writeSnapshot()
    const provider = await createReloadingLocalIndexerStore({ mode: 'snapshot', file: snapshot.file })

    const first = await provider()
    const second = await provider()
    expect(second).toBe(first)

    const parsed = JSON.parse(await readFile(snapshot.file, 'utf8'))
    parsed.names[0].canonicalName = 'Renamed.Dusk'
    await writeFile(snapshot.file, JSON.stringify(parsed), 'utf8')

    const third = await provider()
    expect(third).not.toBe(first)
    expect(third.namesByCanonical.has('renamed.dusk')).toBe(true)
  })

  it('keeps released snapshot names and subnames out of active routes', async () => {
    const snapshot = await writeSnapshot({ released: true })
    const store = await loadSnapshotStore(snapshot.file)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
      ok: true,
      mode: 'snapshot',
      names: 1,
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
    await expect(expectJson(`${baseUrl}/names?owner=${snapshot.owner}`)).resolves.toEqual([])
    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address&value=${snapshot.moonlight}`)).resolves.toBeNull()
    await expect(expectJson(`${baseUrl}/subnames?parentNode=${snapshot.node}`)).resolves.toEqual([])
    await expect(expectJson(`${baseUrl}/name?node=${snapshot.node}`)).resolves.toMatchObject({
      canonicalName: 'aurora.dusk',
      status: 'released',
      owner: null,
      resolverId: null,
    })
    await expect(expectJson(`${baseUrl}/subname?node=${snapshot.subnode}`)).resolves.toBeNull()
  })

  it('excludes revoked snapshot subnames from active parent lists and summaries', async () => {
    const snapshot = await writeSnapshot({ revokedSubname: true })
    const store = await loadSnapshotStore(snapshot.file)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/subnames?parentNode=${snapshot.node}`)).resolves.toEqual([])
    await expect(expectJson(`${baseUrl}/names?owner=${snapshot.owner}`)).resolves.toMatchObject([{
      canonicalName: 'aurora.dusk',
      subnameCount: 0,
    }])
    await expect(expectJson(`${baseUrl}/subname?node=${snapshot.subnode}`)).resolves.toBeNull()
  })

  it('serves snapshot subname records without inheriting parent records', async () => {
    const snapshot = await writeSnapshot({ subnameRecord: true })
    const store = await loadSnapshotStore(snapshot.file)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/resolve?name=settlement.aurora.dusk`)).resolves.toMatchObject({
      canonicalName: 'settlement.aurora.dusk',
      node: snapshot.subnode,
      verificationStatus: 'forward_resolved',
      records: [{
        key: 'dusk_contract',
        value: snapshot.subnameContract,
      }],
    })
    const response = await expectJson(`${baseUrl}/resolve?name=settlement.aurora.dusk`)
    expect(response.records.some((record) => (
      record.key === 'moonlight_address' && record.value === snapshot.moonlight
    ))).toBe(false)
  })
})
