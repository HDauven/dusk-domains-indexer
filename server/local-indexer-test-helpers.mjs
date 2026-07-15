import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect } from 'vitest'
import { createLocalIndexerHandler } from './local-indexer.mjs'

export {
  createEventLog,
  createExpiredRoutingEventLogFixture,
  createLifecycleCleanupEventLogFixture,
  createReleaseReregistrationEventLogFixture,
} from './local-indexer-event-fixtures.mjs'

export const expectedLocalIndexerRoutes = [
  '/health',
  '/commitment',
  '/search',
  '/names',
  '/resolve',
  '/name',
  '/records',
  '/record',
  '/record-history',
  '/activity',
  '/reverse',
  '/subnames',
  '/subname',
  '/treasury',
  '/referrals',
  '/fee-config',
  '/marketplace/config',
  '/marketplace/fixed-sales',
  '/marketplace/fixed-sale',
  '/marketplace/auctions',
  '/marketplace/auction',
  '/marketplace/offers',
  '/marketplace/offer',
  '/marketplace/refund',
]

const tempDirs = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

export async function startServer(storeProvider, handlerOptions = {}) {
  const server = createServer(createLocalIndexerHandler(storeProvider, handlerOptions))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

export async function expectJson(url) {
  const response = await fetch(url)
  expect(response.ok).toBe(true)
  return response.json()
}

export async function writeSnapshot(snapshot, file) {
  const snapshotFile = file ?? join(await mkdtempTracked(), 'snapshot.json')
  await writeFile(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  return snapshotFile
}

export async function writeEventLog(events, file) {
  const eventLogFile = file ?? join(await mkdtempTracked(), 'events.jsonl')
  await writeFile(eventLogFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
  return eventLogFile
}

export async function writeCursor(cursor, file) {
  const cursorFile = file ?? join(await mkdtempTracked(), 'cursor.json')
  const body = typeof cursor === 'string' ? cursor : JSON.stringify({
    version: 1,
    source: 'w3sper-live-subscription',
    startedAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:02.000Z',
    ...cursor,
  }, null, 2)
  await writeFile(cursorFile, `${body}\n`, 'utf8')
  return cursorFile
}

export function createSnapshot({ owner, controller, activity: extraActivity = [], records, reverse, nameOverrides = {} } = {}) {
  const node = `0x${'aa'.repeat(32)}`
  const subnode = `0x${'bb'.repeat(32)}`
  const activity = [{
    id: `registration:${node}:${owner}:local-registrar`,
    eventType: 'registration',
    node,
    name: 'aurora.dusk',
    actor: owner,
    target: owner,
    timestamp: '2026-06-17T00:00:00.000Z',
    blockHeight: null,
    txId: 'local-registrar',
  }]
  if (controller) {
    activity.unshift({
      id: `record_update:${node}:${controller}:local-record`,
      eventType: 'record_update',
      node,
      name: 'aurora.dusk',
      actor: controller,
      target: 'moonlight_address',
      timestamp: '2026-06-17T00:00:01.000Z',
      blockHeight: null,
      txId: 'local-record',
    })
  }
  activity.unshift(...extraActivity)

  return {
    version: 1,
    generatedAt: '2026-06-17T00:00:00.000Z',
    source: 'local-rusk-private-e2e',
    names: [{
      canonicalName: 'aurora.dusk',
      node,
      owner,
      manager: owner,
      resolverId: `0x${'cc'.repeat(32)}`,
      resolverHealth: 'ok',
      expiresAt: '2027-06-17T00:00:00.000Z',
      graceEndsAt: '2027-07-17T00:00:00.000Z',
      status: 'active',
      lastEventType: 'name_owner_changed',
      records: records ?? [{
        key: 'moonlight_address',
        value: 'dusk1localresolverproof01',
        visibility: 'public',
        updatedAt: '2026-06-17T00:00:00.000Z',
        ttlSeconds: 300,
      }],
      activity,
      ...nameOverrides,
    }],
    reverse: reverse ?? [{
      endpoint: {
        type: 'moonlight_address',
        value: 'dusk1localresolverproof01',
      },
      primaryName: 'aurora.dusk',
      node,
      controller: owner,
      updatedAt: '2026-06-17T00:00:00.000Z',
    }],
    subnames: [{
      parentNode: node,
      node: subnode,
      parentName: 'aurora.dusk',
      name: 'settlement.aurora.dusk',
      label: 'settlement',
      owner,
      manager: owner,
      resolver: `0x${'cc'.repeat(32)}`,
      expiresAt: '2027-06-17T00:00:00.000Z',
      parentExpiresAt: '2027-06-17T00:00:00.000Z',
      expiryPolicy: 'fixed_before_parent',
      revocationPolicy: 'parent_revocable',
      status: 'active',
      createdAt: '2026-06-17T00:00:00.000Z',
      revokedAt: null,
      lastEventType: 'subname_created',
      txId: 'local-subname',
      blockHeight: null,
    }],
  }
}

async function mkdtempTracked() {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-indexer-test-'))
  tempDirs.push(dir)
  return dir
}
