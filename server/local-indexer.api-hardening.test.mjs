import { describe, expect, it, vi } from 'vitest'
import { createLocalIndexerHandler } from './local-indexer/routes.mjs'
import { serveLocalIndexer } from './local-indexer/server.mjs'
import { createRateLimiter } from './local-indexer/security.mjs'
import { parseArgs } from './local-indexer/cli.mjs'
import { indexNamesByAuthority } from './local-indexer/name-authority-index.mjs'

const node = `0x${'11'.repeat(32)}`
const owner = `0x${'22'.repeat(32)}`
const hex = (index) => `0x${index.toString(16).padStart(64, '0')}`

function storeWithRows(count = 205) {
  const names = Array.from({ length: count }, (_, index) => ({
    node: hex(index), records: [], lifecycle: {
      canonicalName: `name${String(index).padStart(4, '0')}.dusk`, node: hex(index), owner, status: 'active',
    },
  }))
  const rows = names.map((name, index) => ({
    node: name.node, name: name.lifecycle.canonicalName, parentNode: node, status: 'active',
    key: `key${String(index).padStart(4, '0')}`, blockHeight: 10, txId: `tx${index}`, eventIndex: index,
    id: `event${index}`, buyerAuthority: owner,
  }))
  return {
    namesByAuthority: indexNamesByAuthority(new Map(names.map((name) => [name.lifecycle.canonicalName, name]))),
    namesByCanonical: new Map(names.map((name) => [name.lifecycle.canonicalName, name])),
    namesByNode: new Map([[node, { node, status: 'active' }], ...names.map((name) => [name.node, name.lifecycle])]),
    subnamesByNode: new Map(), reverseByEndpoint: new Map(),
    recordsByNode: new Map([[node, rows]]), recordHistoryByNode: new Map([[node, rows]]),
    activityByNode: new Map([[node, rows]]), subnamesByParent: new Map([[node, rows]]),
    marketplaceFixedSalesByNode: new Map(rows.map((row) => [row.node, row])),
    marketplaceAuctionsByNode: new Map(rows.map((row) => [row.node, row])),
    marketplaceOffersByKey: new Map(rows.map((row) => [row.node, row])),
  }
}

function request(handler, url, { method = 'GET', ip = '127.0.0.1', headers = {} } = {}) {
  return new Promise((resolve) => {
    let status, responseHeaders
    handler({ url, method, headers, socket: { remoteAddress: ip } }, {
      writeHead(code, values) { status = code; responseHeaders = values },
      end(body) { resolve({ status, headers: responseHeaders, body: body ? JSON.parse(body) : null }) },
    })
  })
}

const routes = [
  ['/names', 'names'], ['/names?owner=' + owner, 'names'],
  ['/records?node=' + node, 'records'], ['/record-history?node=' + node, 'history'],
  ['/activity?node=' + node, 'activity'], ['/subnames?parentNode=' + node, 'subnames'],
  ['/marketplace/fixed-sales', 'fixedSales'], ['/marketplace/auctions', 'auctions'], ['/marketplace/offers', 'offers'],
]

describe('public API pagination', () => {
  it.each(routes)('bounds and traverses %s without losing tied sort keys', async (path, field) => {
    const handler = createLocalIndexerHandler(storeWithRows())
    const separator = path.includes('?') ? '&' : '?'
    expect((await request(handler, path)).body[field]).toHaveLength(50)
    const first = await request(handler, `${path}${separator}limit=999`)
    expect(first.body[field]).toHaveLength(200)
    expect(first.body.nextCursor).toEqual(expect.any(String))
    const last = await request(handler, `${path}${separator}cursor=${first.body.nextCursor}&limit=200`)
    expect(last.body[field]).toHaveLength(5)
    expect(last.body.nextCursor).toBe(null)
    expect(new Set([...first.body[field], ...last.body[field]].map((row) => row.node)).size).toBe(205)
  })

  it('continues after the last key when a name is inserted before it or deleted', async () => {
    const store = storeWithRows(3)
    const handler = createLocalIndexerHandler(() => store)
    const first = (await request(handler, '/names?limit=1')).body
    const removed = store.namesByCanonical.get(first.names[0].canonicalName)
    store.namesByCanonical.delete(first.names[0].canonicalName)
    store.namesByCanonical.set('aaa.dusk', { ...removed, lifecycle: { ...removed.lifecycle, canonicalName: 'aaa.dusk' } })
    const next = (await request(handler, `/names?limit=2&cursor=${first.nextCursor}`)).body
    expect(next.names.map((name) => name.canonicalName)).toEqual(['name0001.dusk', 'name0002.dusk'])
    expect(next.nextCursor).toBe(null)
  })

  it('keeps newest-first activity traversal stable under inserts', async () => {
    const store = storeWithRows(3)
    const handler = createLocalIndexerHandler(store)
    const first = (await request(handler, `/activity?node=${node}&limit=1`)).body
    const rows = store.activityByNode.get(node)
    rows.unshift({ ...rows[0], blockHeight: 11, id: 'new' })
    const last = (await request(handler, `/activity?node=${node}&cursor=${first.nextCursor}`)).body
    expect(last.activity).toHaveLength(2)
    expect(last.activity.some((row) => row.id === 'new')).toBe(false)
  })

  it.each(['0', '-1', '1.5', 'abc', '', ' 2', '1e2', 'Infinity', '2&limit=3'])('rejects limit=%s before loading a store', async (limit) => {
    const provider = vi.fn()
    const response = await request(createLocalIndexerHandler(provider), `/names?limit=${limit}`)
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('invalid_limit')
    expect(provider).not.toHaveBeenCalled()
  })

  it('rejects malformed and cross-query cursors before loading a store', async () => {
    const store = storeWithRows()
    const handler = createLocalIndexerHandler(store)
    const cursor = (await request(handler, '/names?limit=1')).body.nextCursor
    const provider = vi.fn()
    const invalid = createLocalIndexerHandler(provider)
    for (const path of ['/names?cursor=!', '/names?cursor=', `/names?owner=${owner}&cursor=${cursor}`, `/marketplace/auctions?cursor=${cursor}`]) {
      expect((await request(invalid, path)).body.error).toBe('invalid_cursor')
    }
    expect(provider).not.toHaveBeenCalled()
  })

  it('orders activity with missing block metadata by timestamp', async () => {
    const store = storeWithRows(0)
    store.activityByNode.set(node, [
      { id: 'a', timestamp: '2026-01-01T00:00:00Z', blockHeight: null },
      { id: 'b', timestamp: '2026-02-01T00:00:00Z', blockHeight: null },
    ])
    const page = await request(createLocalIndexerHandler(store), `/activity?node=${node}&limit=1`)
    expect(page.body.activity[0].id).toBe('b')
  })

  it('returns an empty terminal page and preserves the single search result', async () => {
    const handler = createLocalIndexerHandler(storeWithRows(0))
    expect((await request(handler, '/names')).body).toEqual({ names: [], nextCursor: null })
    expect((await request(handler, '/search?query=example&limit=1')).body).toMatchObject({ canonical: 'example.dusk', nextCursor: null })
    expect((await request(handler, '/search?query=example&limit=0')).status).toBe(400)
  })

  it('paginates forward warnings using immutable event keys as their age changes', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
      const store = storeWithRows(1)
      const name = store.namesByCanonical.get('name0000.dusk')
      name.activity = Array.from({ length: 205 }, (_, index) => ({
        id: `event${index}`, eventType: 'resolver_change', timestamp: '2026-09-30T00:00:00Z',
        blockHeight: index, node: name.node, name: name.lifecycle.canonicalName, actor: owner,
      }))
      const handler = createLocalIndexerHandler(store)
      const first = (await request(handler, '/resolve?name=name0000&limit=200')).body
      expect(first.warnings).toHaveLength(200)
      expect(first.nextCursor).toEqual(expect.any(String))
      vi.setSystemTime(new Date('2026-10-01T00:01:00Z'))
      const last = (await request(handler, `/resolve?name=name0000&cursor=${first.nextCursor}`)).body
      expect(last.warnings).toHaveLength(5)
      expect(last.nextCursor).toBe(null)
      expect(new Set([...first.warnings, ...last.warnings].map((row) => row.blockHeight)).size).toBe(205)
      expect((await request(handler, '/resolve?name=name0000&limit=0')).status).toBe(400)
    } finally {
      vi.useRealTimers()
    }
  })

  it('only hydrates the selected names', async () => {
    const store = storeWithRows()
    const omitted = store.namesByCanonical.get('name0204.dusk')
    Object.defineProperty(omitted, 'records', { get() { throw new Error('unselected name was hydrated') } })
    expect((await request(createLocalIndexerHandler(store), '/names?limit=1')).status).toBe(200)
  })
})

describe('public HTTP security', () => {
  it('bounds health diagnostics and logs internal messages instead of exposing them', async () => {
    const store = storeWithRows(0)
    store.warnings = Array.from({ length: 205 }, (_, line) => ({ code: 'invalid_event_log_row', line, message: 'private warning' }))
    store.health = { ok: false, code: 'unsafe', message: 'private health' }
    store.cursor = { reason: 'private cursor' }
    store.durability = { ok: false, message: 'private durability', eventLogFile: '/private/events', checks: [{ id: 'checkpoint', ok: false, message: 'private check' }] }
    store.sqlite = { dbFile: '/private/store', journalMode: 'wal' }
    const logger = { warn: vi.fn(), error: vi.fn() }
    const handler = createLocalIndexerHandler(store, { logger })
    const first = await request(handler, '/health?limit=200')
    expect(first.body.warnings).toHaveLength(200)
    expect(first.body.nextCursor).toEqual(expect.any(String))
    expect(JSON.stringify(first.body)).not.toContain('private')
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ requestId: first.headers['x-request-id'], warnings: expect.arrayContaining([expect.objectContaining({ message: 'private warning' })]) }))
    const last = await request(handler, `/health?cursor=${first.body.nextCursor}`)
    expect(last.body.warnings).toHaveLength(5)
    expect(last.body.nextCursor).toBe(null)
    expect(last.body.ok).toBe(false)
  })

  it('warns on startup when production CORS has no usable allowlist', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(serveLocalIndexer(parseArgs(['--snapshot', '.tmp/missing-startup-snapshot.json'], { NODE_ENV: 'production' }))).rejects.toThrow()
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('cross-origin browser access is disabled'))
    } finally {
      warning.mockRestore()
    }
  })

  it('handles malformed request URLs as client errors and serialization failures as server errors', async () => {
    const provider = vi.fn(() => ({ marketplaceConfig: { unsupported: 1n } }))
    const logger = { error: vi.fn() }
    const handler = createLocalIndexerHandler(provider, { logger })
    expect((await request(handler, 'http://[')).body).toEqual({ error: 'invalid_url', message: 'Invalid request URL.' })
    expect(provider).not.toHaveBeenCalled()
    expect((await request(handler, '/marketplace/config')).body).toEqual({ error: 'internal_error', requestId: expect.any(String) })
    expect(logger.error).toHaveBeenCalledOnce()
  })

  it('returns generic failures with matching request IDs and logs the details', async () => {
    const error = new Error('private database path /secret/indexer.sqlite')
    const logger = { error: vi.fn() }
    const handler = createLocalIndexerHandler(() => { throw error }, { logger })
    const response = await request(handler, '/health')
    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal_error', requestId: expect.any(String) })
    expect(response.headers['x-request-id']).toBe(response.body.requestId)
    expect(logger.error).toHaveBeenCalledWith({ requestId: response.body.requestId, error })
    expect(JSON.stringify(response.body)).not.toContain('private')
    expect((await request(handler, '/missing')).body).toEqual({ error: 'not_found', message: 'Route not found.' })
  })

  it('limits each IP before store access, ignores spoofed proxies, and resets the window', async () => {
    let now = 0
    const provider = vi.fn(() => storeWithRows(0))
    const handler = createLocalIndexerHandler(provider, { rateLimit: true, rateLimitMax: 2, rateLimitWindowMs: 10_000, now: () => now })
    expect((await request(handler, '/names')).status).toBe(200)
    expect((await request(handler, '/names')).status).toBe(200)
    const denied = await request(handler, '/names', { headers: { 'x-forwarded-for': '8.8.8.8' } })
    expect(denied.status).toBe(429)
    expect(denied.headers['retry-after']).toBe('10')
    expect(provider).toHaveBeenCalledTimes(2)
    expect((await request(handler, '/names', { ip: '127.0.0.2' })).status).toBe(200)
    now = 10_000
    expect((await request(handler, '/names')).status).toBe(200)
  })

  it('only uses forwarded addresses when explicitly trusted and normalizes mapped IPv4', async () => {
    const handler = createLocalIndexerHandler(storeWithRows(0), { trustedProxy: true, rateLimit: true, rateLimitMax: 1 })
    expect((await request(handler, '/names', { headers: { 'x-forwarded-for': '9.9.9.1, 1.2.3.4' } })).status).toBe(200)
    // A client-supplied entry on the left can't buy a fresh budget.
    expect((await request(handler, '/names', { headers: { 'x-forwarded-for': '9.9.9.2, 1.2.3.4' } })).status).toBe(429)
    expect((await request(handler, '/names', { headers: { 'x-forwarded-for': '::ffff:1.2.3.4' } })).status).toBe(429)
    expect((await request(handler, '/names', { headers: { 'x-forwarded-for': '1.2.3.5' } })).status).toBe(200)
    expect((await request(handler, '/names', { headers: { 'x-forwarded-for': 'garbage' } })).status).toBe(200)
    expect((await request(handler, '/names')).status).toBe(429)
  })

  it.each([false, true])('shares IPv6 /64 budgets and keeps IPv4 addresses separate (proxy %s)', async (trustedProxy) => {
    const handler = createLocalIndexerHandler(storeWithRows(0), { trustedProxy, rateLimit: true, rateLimitMax: 1 })
    const read = (ip) => request(handler, '/names', trustedProxy ? { headers: { 'x-forwarded-for': `8.8.8.8, ${ip}` } } : { ip })
    expect((await read('2001:db8:1234:5678::1')).status).toBe(200)
    expect((await read('2001:0DB8:1234:5678:ffff:ffff:ffff:ffff')).status).toBe(429)
    expect((await read('2001:db8:1234:5679::1')).status).toBe(200)
    expect((await read('::1')).status).toBe(200)
    expect((await read('0:0:0:0::2')).status).toBe(429)
    expect((await read('1.2.3.4')).status).toBe(200)
    expect((await read('::ffff:102:304')).status).toBe(429)
    expect((await read('0:0:0:0:0:ffff:1.2.3.4')).status).toBe(429)
    expect((await read('1.2.3.5')).status).toBe(200)
  })

  it('reclaims expired capacity immediately without resetting active budgets', () => {
    let now = 0
    const limit = createRateLimiter({ rateLimit: true, rateLimitMax: 1, rateLimitWindowMs: 1000, now: () => now })
    const read = (ip) => limit({ headers: {}, socket: { remoteAddress: ip } })
    expect(read('10.0.0.1')).toBe(0)
    now = 1
    for (let index = 0; index < 99_999; index++) {
      expect(read(`172.${index >>> 16}.${(index >>> 8) & 255}.${index & 255}`)).toBe(0)
    }
    expect(read('192.0.2.1')).toBe(1)
    now = 1000
    expect(read('10.0.0.1')).toBe(0)
    now = 1001
    expect(read('192.0.2.1')).toBe(0)
    expect(read('10.0.0.1')).toBe(1)
  })

  it('allows four measured frontend sessions within the production default budget', () => {
    const options = parseArgs([], { NODE_ENV: 'production' })
    expect(options.rateLimitMax).toBe(200)
    for (const config of [options, { production: true }]) {
      const limit = createRateLimiter({ ...config, now: () => 0 })
      const client = { headers: {}, socket: { remoteAddress: '192.0.2.1' } }
      for (let index = 0; index < 200; index++) expect(limit(client)).toBe(0)
      expect(limit(client)).toBe(60)
    }
  })

  it('disables limiting in development and enables it in production configuration', async () => {
    expect(parseArgs([], {})).toMatchObject({ production: false, rateLimit: false, trustedProxy: false, corsOrigin: '*' })
    expect(parseArgs([], { NODE_ENV: 'production' })).toMatchObject({ production: true, rateLimit: true, corsOrigin: '' })
    expect(parseArgs([], { DUSK_DOMAINS_INDEXER_RATE_LIMIT: 'false', DUSK_DOMAINS_INDEXER_RATE_LIMIT_MAX: '3', DUSK_DOMAINS_INDEXER_RATE_LIMIT_WINDOW_MS: '5000', DUSK_DOMAINS_INDEXER_TRUST_PROXY: 'true' })).toMatchObject({ rateLimit: false, rateLimitMax: 3, rateLimitWindowMs: 5000, trustedProxy: true })
    expect(() => parseArgs([], { DUSK_DOMAINS_INDEXER_RATE_LIMIT_MAX: '0' })).toThrow()
    const handler = createLocalIndexerHandler(storeWithRows(0), { rateLimitMax: 1 })
    expect((await request(handler, '/names')).status).toBe(200)
    expect((await request(handler, '/names')).status).toBe(200)
  })

  it('uses exact CORS allowlists for successful, failed, preflight, and limited responses', async () => {
    const options = parseArgs([], { NODE_ENV: 'production', DUSK_DOMAINS_INDEXER_CORS_ORIGINS: 'https://one.example, https://two.example' })
    const handler = createLocalIndexerHandler(storeWithRows(0), { ...options, rateLimitMax: 3 })
    const headers = { origin: 'https://two.example' }
    for (const [path, method] of [['/names', 'GET'], ['/missing', 'GET'], ['/names', 'OPTIONS'], ['/names', 'GET']]) {
      const response = await request(handler, path, { method, headers })
      expect(response.headers['access-control-allow-origin']).toBe(headers.origin)
      expect(response.headers.vary).toBe('Origin')
    }
    for (const origin of ['https://one.example.attacker', 'null', undefined]) {
      expect((await request(handler, '/names', { headers: { origin } })).headers).not.toHaveProperty('access-control-allow-origin')
    }
    for (const corsOrigin of ['', '*']) {
      const closed = createLocalIndexerHandler(storeWithRows(0), { production: true, corsOrigin })
      expect((await request(closed, '/names', { headers })).headers).not.toHaveProperty('access-control-allow-origin')
    }
    expect((await request(createLocalIndexerHandler(storeWithRows(0)), '/names')).headers['access-control-allow-origin']).toBe('*')
  })
})
