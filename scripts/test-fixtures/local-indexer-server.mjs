import { createEventLog, rootNode, childNode, address, prefixed } from './frozen-events.mjs'
import { LIST_FIELDS } from '../../server/local-indexer/pagination.mjs'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createLocalIndexerHandler } from '../../server/local-indexer.mjs'

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

export async function writeSnapshot(options = {}, context = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-local-indexer-api-test-'))
  context.trackTempDir?.(dir)
  const file = join(dir, 'snapshot.json')
  const node = `0x${'aa'.repeat(32)}`
  const otherNode = `0x${'ab'.repeat(32)}`
  const subnode = `0x${'bb'.repeat(32)}`
  const owner = `0x${'09'.repeat(32)}`
  const manager = `0x${'08'.repeat(32)}`
  const controller = `0x${'06'.repeat(32)}`
  const resolverId = `0x${'07'.repeat(32)}`
  const moonlight = 'dusk1localresolverproof01'
  const phoenix = 'phoenix-public-endpoint'
  const subnameContract = `0x${'35'.repeat(32)}`

  await writeFile(file, JSON.stringify({
    generatedAt: '2026-06-17T20:30:00.000Z',
    source: 'test-snapshot',
    checkpoint: {
      lastBlockHeight: 42,
    },
    names: [
      {
        node,
        canonicalName: 'Aurora.Dusk',
        owner: options.released ? null : owner,
        manager: options.released ? null : manager,
        resolverId: options.released ? null : resolverId,
        expiresAt: '2027-06-17T20:30:00.000Z',
        graceEndsAt: '2027-07-17T20:30:00.000Z',
        status: options.released ? 'released' : 'active',
        lastEventType: options.released ? 'name_released' : 'name_owner_changed',
        controllers: [controller],
        records: [{
          key: 'moonlight_address',
          value: moonlight,
          ttlSeconds: 120,
          updatedAt: '2026-06-17T20:31:00.000Z',
          visibility: 'public',
        }],
        activity: [{
          id: `record_update:${node}:moonlight_address`,
          eventType: 'record_update',
          node,
          name: 'aurora.dusk',
          actor: owner,
          target: 'moonlight_address',
          timestamp: '2026-06-17T20:31:00.000Z',
          blockHeight: 12,
        }],
      },
      {
        node: otherNode,
        canonicalName: 'alice.dusk',
        owner: `0x${'11'.repeat(32)}`,
        manager: `0x${'12'.repeat(32)}`,
        resolverId,
        status: 'active',
        records: [],
        activity: [],
      },
    ],
    reverse: [
      {
        endpoint: {
          type: 'moonlight_address',
          value: moonlight,
        },
        node,
        primaryName: 'aurora.dusk',
      },
      {
        endpoint: {
          type: 'phoenix_payment_endpoint',
          value: phoenix,
        },
        node,
        primaryName: 'aurora.dusk',
      },
      {
        endpoint: {
          type: 'dusk_contract',
          value: subnameContract,
        },
        node,
        primaryName: 'aurora.dusk',
      },
    ],
    subnames: [{
      node: subnode,
      parentNode: node,
      name: 'settlement.aurora.dusk',
      manager,
      resolver: resolverId,
      status: options.expiredSubname ? 'expired' : 'active',
      createdAt: '2026-06-17T20:32:00.000Z',
      records: options.subnameRecord ? [{
        key: 'dusk_contract',
        value: subnameContract,
        ttlSeconds: 120,
        updatedAt: '2026-06-17T20:32:30.000Z',
        visibility: 'public',
      }] : [],
    }],
    treasury: {
      initialized: true,
      operatorAuthority: owner,
      operatorRecipient: 'dusk1operator',
      allowedFeeSources: [controller],
      totalReceivedLux: 70_000_000_000,
      availableLux: 35_000_000_000,
      registrationReceivedLux: 35_000_000_000,
      renewalReceivedLux: 35_000_000_000,
      otherReceivedLux: 0,
      lastFeeSourceContract: controller,
      lastFeeReason: 'renewal',
      lastFeeNode: node,
      lastEventType: 'treasury_fee_received',
      txId: 'tx-renew-fee',
      blockHeight: 42,
      claims: [{
        operatorAuthority: owner,
        operatorRecipient: 'dusk1operator',
        amountLux: 10_000_000_000,
        remainingLux: 35_000_000_000,
        txId: 'tx-claim',
        blockHeight: 43,
      }],
    },
    referrals: [{
      supported: true,
      referrer: owner,
      claimableLux: 7_000_000_000,
      claimedLux: 3_000_000_000,
      referralCount: 2,
      recentActivity: [{
        txId: 'tx-referral-accrual',
        blockHeight: 44,
        amountLux: 2_000_000_000,
        kind: 'accrual',
        counterparty: controller,
      }],
    }],
  }), 'utf8')

  return {
    file,
    node,
    subnode,
    owner,
    controller,
    moonlight,
    phoenix,
    contract: subnameContract,
    subnameContract,
  }
}

export async function writeEventLog(options = {}, context = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-frozen-api-test-'))
  context.trackTempDir?.(dir)
  const eventLogFile = join(dir, 'events.jsonl'), cursorFile = join(dir, 'cursor.json')
  const events = createEventLog(), rows = events.map(e => JSON.stringify(e))
  if (options.malformedRow) rows.splice(1, 0, '{"event":')
  if (options.malformedEvent) {
    const bad = structuredClone(events.at(-1))
    bad.meta.eventId = bad.event.receipt.id = 'bad-receipt'
    bad.event.receipt.events[1].data = '{"broken":true}'
    rows.push(JSON.stringify(bad))
  }
  await writeFile(eventLogFile, rows.join('\n') + '\n')
  await writeFile(cursorFile, JSON.stringify({ version: 2, source: 'rusk-finalized-archive', status: 'running',
    fromBlock: 1, scannedBlockHeight: 14, currentBlockHeight: 14, scannedBlockHash: '11'.repeat(32),
    updatedAt: new Date().toISOString(), eventLogBytes: Buffer.byteLength(rows.join('\n') + '\n'), eventCount: rows.length, lastEventName: 'frozen_receipt', lastBlockHeight: 14 }))
  return { eventLogFile, cursorFile, node: rootNode, subnode: childNode, owner: prefixed(10), controller: prefixed(11), moonlight: address }
}

export async function startIndexer(store, context = {}) {
  const storeProvider = typeof store === 'function' ? store : () => store
  const server = createServer(createLocalIndexerHandler(storeProvider, context.handlerOptions ?? {}))
  context.trackServer?.(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

export async function expectJson(url, options = {}) {
  const response = await fetch(url, { method: options.method ?? 'GET' })
  expect(response.status).toBe(options.expectedStatus ?? 200)
  const body = await response.json()
  const field = LIST_FIELDS[new URL(url).pathname]
  if (field && response.ok) {
    expect(body.nextCursor).toBe(null)
    return body[field]
  }
  return body
}

export async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
