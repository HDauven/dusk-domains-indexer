import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function createLocalIndexerSmokeTestContext() {
  const tempDirs = []

  return {
    async cleanup() {
      await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    },

    async writeEnvFile(contents) {
      const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-indexer-smoke-test-'))
      tempDirs.push(dir)
      const file = join(dir, '.env.local')
      await writeFile(file, contents, 'utf8')
      return file
    },

    async writeSnapshot() {
      const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-indexer-smoke-snapshot-test-'))
      tempDirs.push(dir)
      const file = join(dir, 'snapshot.json')
      const node = `0x${'aa'.repeat(32)}`
      const subnode = `0x${'bb'.repeat(32)}`
      const owner = `0x${'09'.repeat(32)}`
      const resolver = `0x${'12'.repeat(32)}`
      const moonlight = 'dusk1localresolverproof01'
      await writeFile(file, JSON.stringify({
        version: 1,
        generatedAt: '2026-06-17T22:41:02.342Z',
        source: 'test-snapshot',
        names: [{
          canonicalName: 'aurora.dusk',
          node,
          owner,
          manager: owner,
          resolverId: resolver,
          resolverHealth: 'ok',
          expiresAt: '2027-06-17T22:38:42.000Z',
          graceEndsAt: '2027-07-17T22:38:42.000Z',
          status: 'active',
          lastEventType: 'name_owner_changed',
          records: [{
            key: 'moonlight_address',
            value: moonlight,
            visibility: 'public',
            updatedAt: '2026-06-17T22:40:02.000Z',
            ttlSeconds: 300,
          }],
          activity: [{
            id: 'registration:test',
            eventType: 'registration',
            node,
            name: 'aurora.dusk',
            actor: owner,
            timestamp: '2026-06-17T22:38:42.000Z',
            blockHeight: null,
            txId: 'local-registrar',
          }],
        }],
        reverse: [{
          endpoint: {
            type: 'moonlight_address',
            value: moonlight,
          },
          primaryName: 'aurora.dusk',
          node,
          controller: owner,
          updatedAt: '2026-06-17T22:40:22.000Z',
        }],
        subnames: [{
          parentNode: node,
          node: subnode,
          parentName: 'aurora.dusk',
          name: 'settlement.aurora.dusk',
          label: 'settlement',
          owner,
          manager: owner,
          resolver,
          expiresAt: '2027-06-17T22:39:02.000Z',
          parentExpiresAt: '2027-06-17T22:39:02.000Z',
          expiryPolicy: 'fixed_before_parent',
          revocationPolicy: 'parent_revocable',
          status: 'active',
          createdAt: '2026-06-17T22:39:02.000Z',
          revokedAt: null,
          lastEventType: 'subname_created',
          txId: 'local-subname',
          blockHeight: null,
        }],
      }), 'utf8')
      return file
    },
  }
}

export function createMockFetch(options = {}) {
  const node = `0x${'aa'.repeat(32)}`
  const subnode = `0x${'bb'.repeat(32)}`
  const moonlight = 'dusk1localresolverproof01'
  const nameSummary = nameSummaryFixture({ moonlight })

  return async (url) => {
    options.seen?.push(String(url))
    const parsed = new URL(String(url))
    if (parsed.pathname === options.failPath) return Response.json({ error: 'missing' }, { status: 500 })
    if (parsed.pathname === '/health') {
      return Response.json({
        ok: options.healthOk ?? true,
        mode: 'event-log',
        ...(options.omitHealthReadinessFields ? {} : {
          schemaVersion: 1,
          currentBlockHeight: 4,
          finalizedBlockHeight: 4,
          lagBlocks: 0,
          eventCount: 4,
          lastEvent: {
            eventName: 'primary_name_changed',
            blockHeight: 4,
            txId: 'tx-reverse',
            contract: 'reverse',
          },
        }),
        routes: options.routes ?? defaultRouteManifest(),
        names: 1,
        cursor: {
          status: 'running',
          eventCount: 4,
        },
        checkpoint: {
          status: 'replayed',
          eventCount: 4,
          rawEventCount: 4,
          duplicateCount: 0,
          warningCount: 0,
          lastContract: 'reverse',
          lastEventName: 'primary_name_changed',
          lastTxId: 'tx-reverse',
          lastBlockHeight: 4,
        },
        ...(options.healthWarnings ? { warnings: options.healthWarnings } : {}),
      })
    }
    if (parsed.pathname === '/commitment') {
      const rawCommitment = parsed.searchParams.get('commitment')
      if (!rawCommitment) {
        return Response.json({
          error: 'missing_commitment',
          parameter: 'commitment',
          message: 'commitment query parameter is required.',
        }, { status: 400 })
      }
      if (!/^0x[a-f0-9]{64}$/.test(rawCommitment)) {
        return Response.json({
          error: 'invalid_commitment',
          parameter: 'commitment',
          message: 'commitment must be a 32-byte hex value.',
        }, { status: 400 })
      }
      return Response.json(null)
    }
    if (parsed.pathname === '/search') {
      const canonical = parsed.searchParams.get('query') === 'settlement.aurora.dusk'
        ? 'settlement.aurora.dusk'
        : 'aurora.dusk'
      return Response.json({
        canonical,
        canonicalRaw: canonical,
        displayName: canonical,
        label: canonical.split('.')[0],
        status: 'registered',
        price: 50,
        issues: [],
        transactionBlocked: true,
      })
    }
    if (parsed.pathname === '/resolve') {
      const canonicalName = parsed.searchParams.get('name') === 'settlement.aurora.dusk'
        ? 'settlement.aurora.dusk'
        : 'aurora.dusk'
      return Response.json({
        canonicalName,
        node: canonicalName === 'settlement.aurora.dusk' ? subnode : node,
        verificationStatus: 'forward_resolved',
        warnings: [],
        records: canonicalName === 'settlement.aurora.dusk'
          ? options.subnameRecords ?? []
          : [{
              key: 'moonlight_address',
              value: moonlight,
            }],
      })
    }
    if (parsed.pathname === '/name') {
      const rawNode = parsed.searchParams.get('node')
      if (!rawNode) {
        return Response.json({
          error: 'missing_node',
          parameter: 'node',
          message: 'node query parameter is required.',
        }, { status: 400 })
      }
      if (parsed.searchParams.get('node') === subnode) {
        return Response.json({
          node: subnode,
          canonicalName: 'settlement.aurora.dusk',
        })
      }
      return Response.json({
        node,
        canonicalName: 'aurora.dusk',
      })
    }
    if (parsed.pathname === '/records' || parsed.pathname === '/record' || parsed.pathname === '/record-history') {
      const rawNode = parsed.searchParams.get('node')
      if (!rawNode) {
        return Response.json({
          error: 'missing_node',
          parameter: 'node',
          message: 'node query parameter is required.',
        }, { status: 400 })
      }
      if (!/^(?:0x)?[a-f0-9]{64}$/.test(String(rawNode ?? ''))) {
        return Response.json({
          error: 'invalid_node',
          parameter: 'node',
          message: 'node must be a 32-byte hex node.',
        }, { status: 400 })
      }
      const key = parsed.searchParams.get('key')
      if (parsed.pathname === '/record' && !key) {
        return Response.json({
          error: 'missing_record_key',
          parameter: 'key',
          message: 'key query parameter is required.',
        }, { status: 400 })
      }
      if (key && /\s/.test(key)) {
        return Response.json({
          error: 'invalid_record_key',
          parameter: 'key',
          message: 'key must be valid.',
        }, { status: 400 })
      }
      const record = { key: 'moonlight_address', value: moonlight, visibility: 'public', updatedAt: '2026-06-17T00:00:00.000Z', ttlSeconds: 300 }
      if (parsed.pathname === '/records') return Response.json([record])
      if (parsed.pathname === '/record-history') return Response.json([])
      return Response.json(key === 'moonlight_address' ? record : null)
    }
    if (parsed.pathname === '/activity') {
      const rawNode = parsed.searchParams.get('node')
      if (!/^0x[a-f0-9]{64}$/.test(String(rawNode ?? ''))) {
        return Response.json({
          error: 'invalid_node',
          parameter: 'node',
          message: 'node must be a 32-byte hex node.',
        }, { status: 400 })
      }
      return Response.json([])
    }
    if (parsed.pathname === '/subnames') {
      if (!parsed.searchParams.get('parentNode')) {
        return Response.json({
          error: 'missing_node',
          parameter: 'parentNode',
          message: 'parentNode query parameter is required.',
        }, { status: 400 })
      }
      return Response.json([{
        node: subnode,
        name: 'settlement.aurora.dusk',
      }])
    }
    if (parsed.pathname === '/subname') {
      const rawNode = parsed.searchParams.get('node')
      if (!rawNode) {
        return Response.json({
          error: 'missing_node',
          parameter: 'node',
          message: 'node query parameter is required.',
        }, { status: 400 })
      }
      if (!/^0x[a-f0-9]{64}$/.test(rawNode)) {
        return Response.json({
          error: 'invalid_node',
          parameter: 'node',
          message: 'node must be a 32-byte hex node.',
        }, { status: 400 })
      }
      return Response.json({
        node: subnode,
        name: 'settlement.aurora.dusk',
        canonicalName: 'settlement.aurora.dusk',
      })
    }
    if (parsed.pathname === '/names') {
      if (parsed.searchParams.get('owner') === '0xmissing-local-smoke') return Response.json([])
      if (parsed.searchParams.has('owner')) return Response.json(options.ownerNames ?? [nameSummary])
      return Response.json(options.names ?? [nameSummary])
    }
    if (parsed.pathname === '/reverse') {
      if (!parsed.searchParams.get('type') || !parsed.searchParams.get('value')) {
        return Response.json({
          error: 'missing_endpoint',
          message: 'type and value query parameters are required.',
        }, { status: 400 })
      }
      if (parsed.searchParams.get('type') === 'wallet') {
        return Response.json({
          error: 'unsupported_endpoint_type',
          type: 'wallet',
          message: 'wallet is not a supported reverse endpoint type.',
        }, { status: 400 })
      }
      return Response.json({
        primaryName: 'aurora.dusk',
        node: options.reverseNode ?? node,
      })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
}

export function defaultRouteManifest() {
  return [
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
}

export function nameSummaryFixture(overrides = {}) {
  const moonlight = overrides.moonlight ?? 'dusk1localresolverproof01'
  return {
    canonicalName: 'aurora.dusk',
    node: `0x${'aa'.repeat(32)}`,
    owner: '0xowner',
    manager: '0xmanager',
    status: 'active',
    records: [{
      key: 'moonlight_address',
      value: moonlight,
    }],
    primaryName: 'aurora.dusk',
    primaryStatus: 'verified',
    subnameCount: 1,
    activityCount: 2,
    ...overrides,
  }
}
