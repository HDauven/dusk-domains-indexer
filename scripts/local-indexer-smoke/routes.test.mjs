import { afterEach, describe, expect, it } from 'vitest'

import { commitJournal } from '../test-fixtures/committed-cursor.mjs'
import { createEventLog } from '../test-fixtures/frozen-events.mjs'
import { loadEventLogStore } from '../../server/local-indexer.mjs'
import { startServer, writeEventLog } from '../../server/local-indexer-test-helpers.mjs'
import {
  checkRouteManifest,
  indexerHealthContract,
  malformedRouteParameterProbes,
  probeRouteParameterErrors,
  requiredLocalIndexerRoutes,
} from './routes.mjs'

describe('local indexer smoke route contract helpers', () => {
  it('requires every MVP route in the health manifest', () => {
    expect(checkRouteManifest(requiredLocalIndexerRoutes)).toMatchObject({
      ok: true,
      message: expect.stringContaining('/referrals'),
    })

    expect(checkRouteManifest(requiredLocalIndexerRoutes.filter((route) => route !== '/reverse'))).toMatchObject({
      ok: false,
      message: expect.stringContaining('/reverse'),
    })
  })

  it('requires the health route to expose production-readiness fields', () => {
    expect(indexerHealthContract({
      ok: true,
      schemaVersion: 1,
      eventCount: 4,
      currentBlockHeight: 10,
      finalizedBlockHeight: 9,
      lagBlocks: 1,
    })).toMatchObject({ ok: true })

    expect(indexerHealthContract({
      ok: false,
      eventCount: 4,
      currentBlockHeight: null,
      finalizedBlockHeight: null,
      lagBlocks: null,
    })).toMatchObject({
      ok: false,
      message: expect.stringContaining('schemaVersion'),
    })
  })

  it('checks that malformed read routes fail with stable 400 error codes', async () => {
    const seen = []
    const expectedByRoute = new Map(malformedRouteParameterProbes.map((probe) => [probe.route, probe.expectedError]))
    const fetcher = async (url) => {
      const parsed = new URL(String(url))
      const route = `${parsed.pathname}${decodeURIComponent(parsed.search)}`
      seen.push(route)
      return Response.json({ error: expectedByRoute.get(route) ?? 'unexpected' }, { status: 400 })
    }

    await expect(probeRouteParameterErrors(fetcher, 'http://127.0.0.1:8787')).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('fail fast'),
    })
    expect(seen).toEqual(malformedRouteParameterProbes.map((probe) => probe.route))
  })

  const servers = []
  afterEach(async () => { for (const server of servers.splice(0)) await server.close() })

  it('requires the holder index and checks every probe against a running indexer', async () => {
    expect(requiredLocalIndexerRoutes).toContain('/holdings')
    expect(malformedRouteParameterProbes.filter((probe) => probe.route.startsWith('/holdings'))).toEqual([
      { route: '/holdings', expectedError: 'missing_authority' },
      { route: '/holdings?authority=not-an-authority', expectedError: 'invalid_authority' },
    ])
    const file = await writeEventLog(createEventLog())
    const server = await startServer(await loadEventLogStore(file, await commitJournal(file, { scannedBlockHeight: 20, currentBlockHeight: 20 })))
    servers.push(server)
    const health = await (await fetch(`${server.baseUrl}/health`)).json()
    expect(checkRouteManifest(health.routes)).toMatchObject({ ok: true })
    await expect(probeRouteParameterErrors(fetch, server.baseUrl)).resolves.toMatchObject({ ok: true })
  })

  it('reports unstable malformed route responses', async () => {
    const fetcher = async () => Response.json({ error: 'wrong_error' }, { status: 500 })

    await expect(probeRouteParameterErrors(fetcher, 'http://127.0.0.1:8787')).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Route parameter errors are unstable'),
    })
  })
})
