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
]

export async function writeSnapshot(options = {}, context = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-names-local-indexer-api-test-'))
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
      status: options.revokedSubname ? 'revoked' : 'active',
      createdAt: '2026-06-17T20:32:00.000Z',
      revokedAt: options.revokedSubname ? '2026-06-17T20:33:00.000Z' : null,
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
  const dir = await mkdtemp(join(tmpdir(), 'dusk-names-local-indexer-event-log-test-'))
  context.trackTempDir?.(dir)
  const eventLogFile = join(dir, 'events.jsonl')
  const cursorFile = join(dir, 'cursor.json')
  const node = `0x${'ca'.repeat(32)}`
  const wrongNode = `0x${'cc'.repeat(32)}`
  const subnode = `0x${'cb'.repeat(32)}`
  const owner = `0x${'31'.repeat(32)}`
  const manager = `0x${'32'.repeat(32)}`
  const controller = `0x${'34'.repeat(32)}`
  const resolverId = `0x${'33'.repeat(32)}`
  const moonlight = 'dusk1localresolverproof02'
  const rotatedMoonlight = 'dusk1localresolverproof03'
  const phoenix = 'phoenix-public-endpoint'
  const subnameContract = `0x${'35'.repeat(32)}`
  const events = [
    {
      event: {
        type: 'name_registered',
        node,
        label: 'aurora',
        actor: owner,
        owner,
        expiresAt: '2027-06-18T00:00:00.000Z',
        graceEndsAt: '2027-07-18T00:00:00.000Z',
        feeLux: 0,
      },
      meta: { txId: 'tx-register', blockHeight: 1 },
    },
    {
      event: {
        type: 'name_owner_changed',
        node,
        actor: owner,
        previousOwner: null,
        owner,
        manager,
        resolver: resolverId,
        expiresAt: '2027-06-18T00:00:00.000Z',
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
          value: moonlight,
          ttlSeconds: 180,
          updatedAt: '2026-06-18T00:01:00.000Z',
          visibility: 'public',
        },
      },
      meta: { txId: 'tx-record', blockHeight: 3 },
    },
    {
      event: {
        type: 'primary_name_changed',
        endpoint: {
          type: 'moonlight_address',
          value: moonlight,
        },
        controller,
        node: options.reverseWrongNode ? wrongNode : node,
        name: 'aurora.dusk',
        previousName: null,
        updatedAt: '2026-06-18T00:02:00.000Z',
      },
      meta: { txId: 'tx-reverse', blockHeight: 4 },
    },
    {
      event: {
        type: 'primary_name_changed',
        endpoint: {
          type: 'phoenix_payment_endpoint',
          value: phoenix,
        },
        controller,
        node,
        name: 'aurora.dusk',
        previousName: null,
        updatedAt: '2026-06-18T00:03:00.000Z',
      },
      meta: { txId: 'tx-phoenix-ignored', blockHeight: 5 },
    },
    {
      event: {
        type: 'subname_created',
        parentNode: node,
        node: subnode,
        parentName: 'aurora.dusk',
        name: 'settlement.aurora.dusk',
        label: 'settlement',
        actor: owner,
        owner,
        manager,
        resolver: resolverId,
        expiresAt: '2027-06-18T00:00:00.000Z',
        parentExpiresAt: '2027-06-18T00:00:00.000Z',
        expiryPolicy: 'inherits_parent',
        revocationPolicy: 'parent_revocable',
        createdAt: '2026-06-18T00:04:00.000Z',
      },
      meta: { txId: 'tx-subname', blockHeight: 6 },
    },
  ]

  if (options.release) {
    events.push({
      event: {
        type: 'name_released',
        node,
        label: 'aurora',
        actor: owner,
        previousOwner: owner,
        releasedAt: '2026-06-18T00:05:00.000Z',
      },
      meta: { txId: 'tx-release', blockHeight: 7 },
    })
  }
  if (options.rotateMoonlightRecord) {
    events.push({
      event: {
        type: 'record_changed',
        node,
        controller,
        record: {
          key: 'moonlight_address',
          value: rotatedMoonlight,
          ttlSeconds: 180,
          updatedAt: '2026-06-18T00:05:00.000Z',
          visibility: 'public',
        },
      },
      meta: { txId: 'tx-record-rotate', blockHeight: 7 },
    })
  }
  if (options.revokeSubname) {
    events.push({
      event: {
        type: 'subname_revoked',
        parentNode: node,
        node: subnode,
        name: 'settlement.aurora.dusk',
        actor: owner,
        revokedAt: '2026-06-18T00:05:00.000Z',
      },
      meta: { txId: 'tx-subname-revoke', blockHeight: 7 },
    })
  }
  if (options.contractReverse) {
    events.push({
      event: {
        type: 'primary_name_changed',
        endpoint: {
          type: 'dusk_contract',
          value: subnameContract,
        },
        controller,
        node,
        name: 'aurora.dusk',
        previousName: null,
        updatedAt: '2026-06-18T00:05:00.000Z',
      },
      meta: { txId: 'tx-contract-reverse', blockHeight: 7 },
    })
  }
  if (options.subnameRecord) {
    events.push({
      event: {
        type: 'record_changed',
        node: subnode,
        controller,
        record: {
          key: 'dusk_contract',
          value: subnameContract,
          ttlSeconds: 180,
          updatedAt: '2026-06-18T00:05:00.000Z',
          visibility: 'public',
        },
      },
      meta: { txId: 'tx-subname-record', blockHeight: 7 },
    })
  }
  if (options.treasuryEvents) {
    events.push({
      event: {
        type: 'treasury_initialized',
        operatorAuthority: owner,
        operatorRecipient: 'dusk1operator',
        allowedFeeSources: [controller],
      },
      meta: { txId: 'tx-treasury-init', blockHeight: 7 },
    })
  }
  if (options.referralEvents) {
    events.push({
      event: {
        type: 'referral_reward_accrued',
        referrer: owner,
        buyer: controller,
        amountLux: 5_000_000_000,
        claimableLux: 5_000_000_000,
        claimedLux: 0,
        referralCount: 1,
      },
      meta: { txId: 'tx-referral-accrual-1', blockHeight: 7 },
    })
    events.push({
      event: {
        type: 'referral_reward_accrued',
        referrer: owner,
        buyer: controller,
        amountLux: 2_000_000_000,
        claimableLux: 7_000_000_000,
        claimedLux: 0,
        referralCount: 2,
      },
      meta: { txId: 'tx-referral-accrual-2', blockHeight: 7 },
    })
    events.push({
      event: {
        type: 'referral_reward_claimed',
        referrer: owner,
        amountLux: 3_000_000_000,
        remainingLux: 4_000_000_000,
        claimedLux: 3_000_000_000,
        referralCount: 2,
      },
      meta: { txId: 'tx-referral-claim', blockHeight: 8 },
    })
  }

  const rows = events.map((event) => JSON.stringify(event))
  if (options.malformedRow) rows.splice(1, 0, '{"event":')
  if (options.malformedEvent) {
    rows.splice(2, 0, JSON.stringify({
      event: {
        type: 'record_changed',
        node,
        controller,
      },
      meta: { txId: 'tx-malformed-record', blockHeight: 99 },
    }))
  }

  await writeFile(eventLogFile, rows.join('\n'), 'utf8')
  await writeFile(cursorFile, JSON.stringify({
    version: 1,
    source: 'test-collector',
    status: 'running',
    eventCount: options.release || options.revokeSubname || options.rotateMoonlightRecord || options.subnameRecord ? 6 : 5,
    startedAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:04:00.000Z',
    lastEventAt: '2026-06-18T00:04:00.000Z',
    lastContract: 'resolver',
    lastEventName: 'subname_created',
  }), 'utf8')

  return {
    eventLogFile,
    cursorFile,
    node,
    wrongNode,
    subnode,
    owner,
    controller,
    moonlight,
    rotatedMoonlight,
    phoenix,
    subnameContract,
  }
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
  return response.json()
}

export async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
