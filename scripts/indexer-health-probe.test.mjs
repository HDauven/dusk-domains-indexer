import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { describe, expect, it } from 'vitest'
import {
  parseArgs,
  probeIndexerHealth,
  writeProbeOutput,
} from './indexer-health-probe.mjs'

const tempDirs = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('indexer health probe', () => {
  it('parses operator options', () => {
    expect(parseArgs([
      '--health-url',
      'https://indexer.example/health',
      '--max-lag-blocks',
      '8',
      '--max-source-age-minutes',
      '15',
      '--min-events',
      '10',
      '--deployment-start-height',
      '100',
      '--archive-snapshot-height',
      '99',
      '--archive-snapshot',
      '/var/snapshots/dusk-before-launch',
      '--out',
      'target/indexer-health.json',
    ])).toEqual({
      help: false,
      healthUrl: 'https://indexer.example/health',
      maxLagBlocks: 8,
      maxSourceAgeMinutes: 15,
      minEvents: 10,
      deploymentStartHeight: 100,
      archiveSnapshotHeight: 99,
      archiveSnapshot: '/var/snapshots/dusk-before-launch',
      out: 'target/indexer-health.json',
    })
  })

  it('uses the Dusk Domains health URL env before the legacy alias', () => {
    expect(parseArgs([], {
      DUSK_DOMAINS_INDEXER_HEALTH_URL: 'https://indexer.example/health',
      DUSK_NAMES_INDEXER_HEALTH_URL: 'https://legacy.example/health',
    })).toMatchObject({
      healthUrl: 'https://indexer.example/health',
    })

    expect(parseArgs([], {
      DUSK_NAMES_INDEXER_HEALTH_URL: 'https://legacy.example/health',
    })).toMatchObject({
      healthUrl: 'https://legacy.example/health',
    })
  })

  it('writes probe output to an artifact path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-indexer-health-'))
    tempDirs.push(dir)
    const out = join(dir, 'nested/indexer-health.json')

    const result = await writeProbeOutput({ ok: true, healthUrl: 'http://indexer/health' }, { out })

    expect(result).toEqual({ writtenTo: out })
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({
      ok: true,
      healthUrl: 'http://indexer/health',
    })
  })

  it('passes a healthy production-shaped response', async () => {
    const result = await probeIndexerHealth({
      healthUrl: 'http://indexer/health',
      maxLagBlocks: 12,
      minEvents: 1,
      fetch: async () => Response.json(healthyPayload()),
    })

    expect(result.ok).toBe(true)
    expect(result.checks.map((check) => [check.id, check.ok])).toEqual([
      ['health_http', true],
      ['health_ok', true],
      ['schema_version', true],
      ['event_count', true],
      ['lag', true],
      ['routes', true],
      ['last_event', true],
    ])
  })

  it('fails unsafe health, stale lag, and missing routes', async () => {
    const result = await probeIndexerHealth({
      healthUrl: 'http://indexer/health',
      maxLagBlocks: 4,
      minEvents: 5,
      fetch: async () => Response.json({
        ...healthyPayload(),
        ok: false,
        lagBlocks: 12,
        eventCount: 2,
        routes: ['/health'],
        durability: { message: 'collector cursor is stale' },
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'health_ok')).toMatchObject({
      ok: false,
      message: expect.stringContaining('collector cursor is stale'),
    })
    expect(result.checks.find((check) => check.id === 'lag')).toMatchObject({ ok: false })
    expect(result.checks.find((check) => check.id === 'routes')).toMatchObject({
      ok: false,
      message: expect.stringContaining('/search'),
    })
  })

  it('fails when source timestamps are older than the configured freshness window', async () => {
    const result = await probeIndexerHealth({
      healthUrl: 'http://indexer/health',
      maxSourceAgeMinutes: 10,
      now: '2026-06-22T00:30:00.000Z',
      fetch: async () => Response.json({
        ...healthyPayload(),
        cursor: {
          updatedAt: '2026-06-22T00:00:00.000Z',
        },
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'source_freshness')).toMatchObject({
      ok: false,
      message: expect.stringContaining('30 minute'),
    })
  })

  it('uses the latest source timestamp for freshness validation', async () => {
    const result = await probeIndexerHealth({
      healthUrl: 'http://indexer/health',
      maxSourceAgeMinutes: 10,
      now: '2026-06-22T00:30:00.000Z',
      fetch: async () => Response.json({
        ...healthyPayload(),
        cursor: {
          updatedAt: '2026-06-22T00:00:00.000Z',
        },
        checkpoint: {
          updatedAt: '2026-06-22T00:25:00.000Z',
        },
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.checks.find((check) => check.id === 'source_freshness')).toMatchObject({
      ok: true,
      message: expect.stringContaining('5 minute'),
    })
  })

  it('fails freshness validation when no source timestamp is available', async () => {
    const { cursor: _cursor, ...payloadWithoutSourceTimestamp } = healthyPayload()
    const result = await probeIndexerHealth({
      healthUrl: 'http://indexer/health',
      maxSourceAgeMinutes: 10,
      now: '2026-06-22T00:30:00.000Z',
      fetch: async () => Response.json(payloadWithoutSourceTimestamp),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'source_freshness')).toMatchObject({
      ok: false,
      message: expect.stringContaining('missing cursor/checkpoint source timestamps'),
    })
  })

  it('fails otherwise healthy indexers that omit the fee config route', async () => {
    const result = await probeIndexerHealth({
      healthUrl: 'http://indexer/health',
      maxLagBlocks: 12,
      minEvents: 1,
      fetch: async () => Response.json({
        ...healthyPayload(),
        routes: healthyPayload().routes.filter((route) => route !== '/fee-config'),
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'routes')).toMatchObject({
      ok: false,
      message: expect.stringContaining('/fee-config'),
    })
  })

  it('fails ok=true health when source event state is missing', async () => {
    const { lastEvent: _lastEvent, ...payloadWithoutLastEvent } = healthyPayload()
    const result = await probeIndexerHealth({
      healthUrl: 'http://indexer/health',
      maxLagBlocks: 12,
      minEvents: 1,
      fetch: async () => Response.json(payloadWithoutLastEvent),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'health_ok')).toMatchObject({ ok: true })
    expect(result.checks.find((check) => check.id === 'last_event')).toMatchObject({
      ok: false,
      message: expect.stringContaining('missing last-event metadata'),
    })
  })

  it('passes launch-height policy when the live indexer and retained archive snapshot cover deployment', async () => {
    const archiveSnapshot = await fixtureFile('archive-node-snapshot')
    const result = await probeIndexerHealth({
      healthUrl: 'http://indexer/health',
      maxLagBlocks: 12,
      minEvents: 1,
      deploymentStartHeight: 100,
      archiveSnapshotHeight: 99,
      archiveSnapshot,
      fetch: async () => Response.json(healthyPayload()),
    })

    expect(result.ok).toBe(true)
    expect(result.checks.find((check) => check.id === 'current_height_after_deployment')).toMatchObject({
      ok: true,
      message: expect.stringContaining('after deployment start 100'),
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_height')).toMatchObject({ ok: true })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_artifact')).toMatchObject({ ok: true })
  })

  it('fails launch-height policy when archive evidence or block metadata is unsafe', async () => {
    const result = await probeIndexerHealth({
      healthUrl: 'http://indexer/health',
      maxLagBlocks: 12,
      minEvents: 1,
      deploymentStartHeight: 200,
      archiveSnapshotHeight: 220,
      archiveSnapshot: '/missing/archive-snapshot',
      fetch: async () => Response.json({
        ...healthyPayload(),
        currentBlockHeight: 199,
        lastEvent: {
          eventName: 'name_registered',
          blockHeight: 150,
        },
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'current_height_after_deployment')).toMatchObject({ ok: false })
    expect(result.checks.find((check) => check.id === 'last_event_after_deployment')).toMatchObject({ ok: false })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_height')).toMatchObject({ ok: false })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_artifact')).toMatchObject({ ok: false })
  })
})

function healthyPayload() {
  return {
    ok: true,
    schemaVersion: 1,
    eventCount: 12,
    currentBlockHeight: 130,
    lagBlocks: 0,
    cursor: {
      updatedAt: '2026-06-22T00:00:00.000Z',
    },
    routes: [
      '/health',
      '/search',
      '/resolve',
      '/name',
      '/records',
      '/record',
      '/record-history',
      '/names',
      '/activity',
      '/reverse',
      '/subnames',
      '/subname',
      '/treasury',
      '/referrals',
      '/fee-config',
    ],
    lastEvent: {
      eventName: 'name_registered',
      blockHeight: 123,
    },
  }
}

async function fixtureFile(name) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-indexer-health-'))
  tempDirs.push(dir)
  const file = join(dir, name)
  await writeFile(file, 'snapshot\n', 'utf8')
  return file
}
