import { afterEach, describe, expect, it } from 'vitest'
import { smokeLocalIndexer } from './local-indexer-smoke.mjs'
import {
  createLocalIndexerSmokeTestContext,
  createMockFetch,
  defaultRouteManifest,
  nameSummaryFixture,
} from './test-fixtures/local-indexer-smoke.mjs'

const fixtures = createLocalIndexerSmokeTestContext()

afterEach(async () => {
  await fixtures.cleanup()
})

describe('local indexer smoke check', () => {
  it('checks every local-live indexer route for the configured name', async () => {
    const envFile = await fixtures.writeEnvFile('VITE_DUSK_DOMAINS_INDEXER_URL=http://127.0.0.1:8787\n')
    const seen = []
    const result = await smokeLocalIndexer({
      envFile,
      name: 'aurora',
      fetch: createMockFetch({ seen }),
    })

    expect(result.ok).toBe(true)
    expect(result.baseUrl).toBe('http://127.0.0.1:8787')
    expect(result.name).toBe('aurora.dusk')
    expect(result.cursor).toMatchObject({ status: 'running' })
    expect(result.checkpoint).toMatchObject({ status: 'replayed', eventCount: 4 })
    expect(result.checks.map((check) => [check.id, check.ok])).toEqual([
      ['health', true],
      ['route_manifest', true],
      ['route_parameter_errors', true],
      ['search', true],
      ['resolve', true],
      ['resolve_warnings', true],
      ['name', true],
      ['activity', true],
      ['subnames', true],
      ['subname', true],
      ['subname_name', true],
      ['subname_search', true],
      ['subname_resolve', true],
      ['names', true],
      ['names_owner_filter', true],
      ['names_missing_owner_filter', true],
      ['reverse', true],
    ])
    expect(seen.map((url) => new URL(url).pathname)).toEqual([
      '/health',
      '/name',
      '/records',
      '/record',
      '/record',
      '/record',
      '/record',
      '/record-history',
      '/commitment',
      '/commitment',
      '/activity',
      '/subnames',
      '/subname',
      '/subname',
      '/reverse',
      '/reverse',
      '/search',
      '/resolve',
      '/name',
      '/activity',
      '/subnames',
      '/subname',
      '/name',
      '/search',
      '/resolve',
      '/names',
      '/names',
      '/names',
      '/reverse',
    ])
  })

  it('uses the Dusk Domains indexer env URL', async () => {
    const envFile = await fixtures.writeEnvFile('VITE_DUSK_DOMAINS_INDEXER_URL=http://127.0.0.1:8789\n')
    const result = await smokeLocalIndexer({
      envFile,
      name: 'aurora',
      fetch: createMockFetch(),
    })

    expect(result.ok).toBe(true)
    expect(result.baseUrl).toBe('http://127.0.0.1:8789')
  })

  it('fails clearly when the health route manifest omits an MVP route', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        routes: defaultRouteManifest().filter((route) => route !== '/reverse'),
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'route_manifest')).toMatchObject({
      ok: false,
      message: expect.stringContaining('/reverse'),
    })
    expect(result.checks.find((check) => check.id === 'reverse')).toMatchObject({
      ok: true,
    })
  })

  it('fails clearly when indexer health is unsafe', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        healthOk: false,
        healthWarnings: [{
          code: 'cursor_stale',
          message: 'Indexer cursor is stale.',
        }],
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'health')).toMatchObject({
      ok: false,
      message: expect.stringContaining('ok=true'),
    })
  })

  it('fails clearly when health omits production readiness fields', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        omitHealthReadinessFields: true,
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'health')).toMatchObject({
      ok: false,
      message: expect.stringContaining('schemaVersion'),
    })
  })

  it('fails clearly when a required route is unavailable', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        failPath: '/reverse',
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'reverse')).toMatchObject({
      ok: false,
      message: expect.stringContaining('/reverse failed'),
    })
    expect(result.checks.find((check) => check.id === 'route_parameter_errors')).toMatchObject({
      ok: false,
      message: expect.stringContaining('/reverse?type=moonlight_address'),
    })
    expect(result.checks.find((check) => check.id === 'reverse')?.message).toContain('missing')
  })

  it('fails when reverse lookup points at a different node than forward resolution', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        reverseNode: `0x${'cc'.repeat(32)}`,
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'reverse')).toMatchObject({
      ok: false,
      message: expect.stringContaining(`node 0x${'cc'.repeat(32)}`),
    })
  })

  it('fails when subname resolution leaks the parent Moonlight record', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        subnameRecords: [{
          key: 'moonlight_address',
          value: 'dusk1localresolverproof01',
        }],
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'subname_resolve')).toMatchObject({
      ok: false,
      message: expect.stringContaining('leaked the parent Moonlight record'),
    })
  })

  it('fails when My Names does not expose a verified primary summary', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        names: [nameSummaryFixture({
          primaryName: 'alice.dusk',
          primaryStatus: 'mismatch',
        })],
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'names')).toMatchObject({
      ok: false,
      message: expect.stringContaining('primary is mismatch'),
    })
  })

  it('fails when My Names does not expose an active lifecycle status', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        names: [nameSummaryFixture({
          status: 'expired',
        })],
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'names')).toMatchObject({
      ok: false,
      message: expect.stringContaining('status is expired'),
    })
  })

  it('fails when My Names summary node differs from forward resolution', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        names: [nameSummaryFixture({
          node: `0x${'cc'.repeat(32)}`,
        })],
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'names')).toMatchObject({
      ok: false,
      message: expect.stringContaining(`node is 0x${'cc'.repeat(32)}`),
    })
  })

  it('fails clearly when owner-filtered names omit portfolio summary fields', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        ownerNames: [{
          canonicalName: 'aurora.dusk',
        }],
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'names')).toMatchObject({
      ok: true,
    })
    expect(result.checks.find((check) => check.id === 'names_owner_filter')).toMatchObject({
      ok: false,
      message: expect.stringContaining('missing subname'),
    })
  })

  it('surfaces local event-log replay warnings from health', async () => {
    const result = await smokeLocalIndexer({
      baseUrl: 'http://127.0.0.1:8787',
      name: 'aurora.dusk',
      fetch: createMockFetch({
        healthWarnings: [{
          code: 'invalid_event_log_row',
          line: 7,
          message: 'Unexpected end of JSON input',
        }],
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.warnings).toMatchObject([{
      code: 'invalid_event_log_row',
      line: 7,
    }])
    expect(result.checks.find((check) => check.id === 'health')?.message)
      .toContain('1 replay warning')
  })

  it('can start a temporary snapshot-backed indexer for route checks', async () => {
    const snapshot = await fixtures.writeSnapshot()
    const result = await smokeLocalIndexer({
      snapshot,
      name: 'aurora.dusk',
    })

    expect(result.ok).toBe(true)
    expect(result.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(result.mode).toBe('snapshot')
    expect(result.source).toMatchObject({
      mode: 'snapshot',
      file: snapshot,
    })
    expect(result.checks.map((check) => [check.id, check.ok])).toEqual([
      ['health', true],
      ['route_manifest', true],
      ['route_parameter_errors', true],
      ['search', true],
      ['resolve', true],
      ['resolve_warnings', true],
      ['name', true],
      ['activity', true],
      ['subnames', true],
      ['subname', true],
      ['subname_name', true],
      ['subname_search', true],
      ['subname_resolve', true],
      ['names', true],
      ['names_owner_filter', true],
      ['names_missing_owner_filter', true],
      ['reverse', true],
    ])
  })
})
