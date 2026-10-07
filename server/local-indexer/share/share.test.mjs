import { inflateSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { loadSnapshotStore } from '../../local-indexer.mjs'
import { createSnapshot, startServer, writeSnapshot } from '../../local-indexer-test-helpers.mjs'
import { createCardCache } from './card.mjs'
import * as card from './card.mjs'

const servers = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  vi.restoreAllMocks()
})

async function fixture(overrides = {}, options = {}) {
  const store = await loadSnapshotStore(await writeSnapshot(createSnapshot(overrides)))
  const server = await startServer(store, options)
  servers.push(server)
  return { ...server, store }
}

it('serves escaped public metadata and canonical human links without tracking parameters', async () => {
  const { baseUrl } = await fixture({ records: [{ key: 'text.description', value: 'A <sunset> & "stars" \'tonight\'', visibility: 'public' }] })
  const response = await fetch(`${baseUrl}/share/name/Aurora.dusk?ref=ignored`, { headers: { host: 'untrusted.example' } })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  const html = await response.text()
  expect(html).toContain('<meta property="og:title" content="aurora.dusk · Dusk Domains">')
  expect(html).toContain('<meta property="og:description" content="A &lt;sunset&gt; &amp; &quot;stars&quot; &#39;tonight&#39;">')
  expect(html).toContain('<meta property="og:image" content="https://dusk.domains/api/share/name/aurora.dusk.png">')
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
  expect(html).toContain('<meta property="og:url" content="https://dusk.domains/name/aurora.dusk">')
  expect(html).toContain('<link rel="canonical" href="https://dusk.domains/name/aurora.dusk">')
  expect(html).toContain('content="0;url=https://dusk.domains/name/aurora.dusk"')
  expect(html).toContain('<a href="https://dusk.domains/name/aurora.dusk">')
  expect(html).not.toMatch(/ignored|untrusted|<sunset>/)
})

it.each(['unknown.dusk', '<script>alert("bad")</script>.dusk', '%E0%A4%A', '-bad.dusk'])('uses the default preview for %s without echoing input', async (name) => {
  const { baseUrl } = await fixture()
  const response = await fetch(`${baseUrl}/share/name/${encodeURIComponent(name)}`)
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('<meta property="og:title" content="Dusk Domains">')
  expect(html).toContain('content="https://dusk.domains/og-image.png"')
  expect(html).toContain('<link rel="canonical" href="https://dusk.domains/">')
  expect(html).not.toContain(name)
  expect(html).not.toContain('<script')
})

it('uses the default description for private records', async () => {
  const { baseUrl } = await fixture({ records: [{ key: 'text.description', value: 'private description', visibility: 'private' }] })
  const html = await (await fetch(`${baseUrl}/share/name/aurora.dusk`)).text()
  expect(html).toContain('aurora.dusk · Dusk Domains')
  expect(html).toContain('Search, register and manage .dusk domains')
  expect(html).not.toContain('private description')
})

it.each([
  { expiresAt: '2000-01-01T00:00:00Z', graceEndsAt: '2100-01-01T00:00:00Z' },
  { status: 'released' },
  { expiresAtBlockHeight: 100 },
])('stops sharing expired or released names, including children: %j', async (nameOverrides) => {
  const { baseUrl, store } = await fixture({ nameOverrides })
  store.currentBlockHeight = 100
  // The chain cursor is authoritative even while the estimated wall-clock expiry is in the future.
  store.cursor = { lastBlockHeight: 100 }
  for (const name of ['aurora.dusk', 'settlement.aurora.dusk']) {
    const html = await (await fetch(`${baseUrl}/share/name/${name}`)).text()
    expect(html).toContain('<meta property="og:title" content="Dusk Domains">')
    expect(html).not.toContain(name)
  }
})

it('returns a complete 1200 by 630 PNG and caches repeated renders', async () => {
  const { baseUrl } = await fixture()
  const response = await fetch(`${baseUrl}/share/name/aurora.dusk.png`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(response.headers.get('cache-control')).toBe('public, max-age=300')
  const png = Buffer.from(await response.arrayBuffer())
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
  const chunks = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  expect(inflateSync(Buffer.concat(chunks)).length).toBeGreaterThan(1200 * 630 * 3)
  expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND')
  expect(Buffer.from(await (await fetch(`${baseUrl}/share/name/aurora.dusk.png`)).arrayBuffer())).toEqual(png)
})

it('evicts the least recently used images within both entry and byte bounds', () => {
  const render = vi.fn(() => Buffer.alloc(4))
  for (const limits of [{ maxEntries: 2, maxBytes: 100 }, { maxEntries: 100, maxBytes: 8 }]) {
    render.mockClear()
    const cache = createCardCache({ ...limits, render })
    cache.get('one'); cache.get('two'); cache.get('one'); cache.get('three'); cache.get('one')
    expect(render).toHaveBeenCalledTimes(3)
    cache.get('two')
    expect(render).toHaveBeenCalledTimes(4)
  }
  render.mockClear()
  const cache = createCardCache({ maxBytes: 3, render })
  cache.get('large'); cache.get('large')
  expect(render).toHaveBeenCalledTimes(2)
})

it('checks current liveness before returning a cached name image', async () => {
  const { baseUrl, store } = await fixture()
  const readPng = async (name) => Buffer.from(await (await fetch(`${baseUrl}/share/name/${name}.png`)).arrayBuffer())
  const known = await readPng('aurora.dusk')
  const lifecycle = store.namesByNode.get(store.namesByCanonical.get('aurora.dusk').node)
  lifecycle.expiresAt = '2000-01-01T00:00:00Z'
  const expired = await readPng('aurora.dusk')
  expect(expired).not.toEqual(known)
  expect(expired).toEqual(await readPng('unknown.dusk'))
})

it.each(['<svg>.dusk', '-bad.dusk', 'a..b.dusk', `${'a'.repeat(64)}.dusk`, 'abc/def.dusk', '%E0%A4%A'])('rejects invalid PNG names before reading the store or rendering: %s', async (name) => {
  const store = vi.fn(() => { throw new Error('Must not read') })
  const render = vi.fn(() => { throw new Error('Must not render') })
  vi.spyOn(card, 'createCardCache').mockReturnValue({ get: render })
  const server = await startServer(store)
  servers.push(server)
  const response = await fetch(`${server.baseUrl}/share/name/${encodeURIComponent(name)}.png`)
  expect(response.status).toBe(400)
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ error: 'invalid_name', message: 'Invalid name.' })
  expect(store).not.toHaveBeenCalled()
  expect(render).not.toHaveBeenCalled()
})

it('shares the API rate limit across HTML, PNG and ordinary reads', async () => {
  const { baseUrl } = await fixture({}, { rateLimit: true, rateLimitMax: 2 })
  expect((await fetch(`${baseUrl}/share/name/aurora.dusk`)).status).toBe(200)
  expect((await fetch(`${baseUrl}/share/name/aurora.dusk.png`)).status).toBe(200)
  const response = await fetch(`${baseUrl}/search?query=aurora`)
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBeTruthy()
})
