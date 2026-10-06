import { afterEach, expect, it, vi } from 'vitest'
import { loadSnapshotStore } from '../../local-indexer.mjs'
import { createSnapshot, startServer, writeSnapshot } from '../../local-indexer-test-helpers.mjs'
import { footerSvg, nameCardSvg, renderNameCard } from './card.mjs'
import { namesSitemap } from './crawler.mjs'
import { siteConfig } from './site.mjs'

const servers = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  vi.unstubAllEnvs()
})

async function fixture() {
  const store = await loadSnapshotStore(await writeSnapshot(createSnapshot()))
  const server = await startServer(store)
  servers.push(server)
  return { ...server, store }
}

it('uses the configured origin for share, crawler, fallback and sitemap URLs', async () => {
  vi.stubEnv('DUSK_DOMAINS_SITE_URL', 'https://testnet.dusk.domains/')
  const { baseUrl } = await fixture()
  for (const path of ['/share/name/aurora.dusk', '/page/name/aurora.dusk']) {
    const response = await fetch(baseUrl + path, { headers: { host: 'untrusted.example' } })
    const html = await response.text()
    expect(html).toContain('<link rel="canonical" href="https://testnet.dusk.domains/name/aurora.dusk">')
    expect(html).toContain('content="https://testnet.dusk.domains/api/share/name/aurora.dusk.png"')
    expect(html).not.toMatch(/https:\/\/dusk.domains|untrusted.example/)
  }
  const crawler = await (await fetch(baseUrl + '/page/name/aurora.dusk')).text()
  expect(crawler).toContain('href="https://testnet.dusk.domains/name/settlement.aurora.dusk"')
  for (const path of ['/share/name/unknown.dusk', '/page/name/-bad.dusk']) {
    const html = await (await fetch(baseUrl + path)).text()
    expect(html).toContain('href="https://testnet.dusk.domains/"')
    expect(html).toContain('content="https://testnet.dusk.domains/og-image.png"')
  }
  const sitemap = await (await fetch(baseUrl + '/sitemap/names.xml')).text()
  expect(sitemap).toContain('<loc>https://testnet.dusk.domains/name/aurora.dusk</loc>')
  expect(sitemap).not.toContain('https://dusk.domains/')
})

it('does not reuse sitemap URLs across origins for the same store', async () => {
  const { store } = await fixture()
  const now = new Date('2026-10-06')
  expect(namesSitemap(store, now)).toContain('https://dusk.domains/name/')
  vi.stubEnv('DUSK_DOMAINS_SITE_URL', 'https://testnet.dusk.domains')
  expect(namesSitemap(store, now)).toContain('https://testnet.dusk.domains/name/')
})

it('uses the origin host in the card footer and renders it in served PNGs', async () => {
  const mainnet = renderNameCard('aurora.dusk')
  vi.stubEnv('DUSK_DOMAINS_SITE_URL', 'https://testnet.dusk.domains/')
  expect(nameCardSvg('aurora.dusk')).toContain('>testnet.dusk.domains</text>')
  expect(footerSvg(null)).toContain('>testnet.dusk.domains</text>')
  const testnet = renderNameCard('aurora.dusk')
  expect(testnet).not.toEqual(mainnet)
  const { baseUrl } = await fixture()
  const png = await fetch(baseUrl + '/share/name/aurora.dusk.png')
  expect(Buffer.from(await png.arrayBuffer())).toEqual(testnet)
})

it.each(['/share/name/aurora.dusk', '/share/name/unknown.dusk', '/share/name/-bad.dusk', '/page/name/aurora.dusk', '/page/name/unknown.dusk', '/page/name/-bad.dusk'])('marks %s noindex when enabled', async path => {
  vi.stubEnv('DUSK_DOMAINS_NOINDEX', 'true')
  const { baseUrl } = await fixture()
  const response = await fetch(baseUrl + path)
  expect(response.headers.get('x-robots-tag')).toBe('noindex')
  expect(await response.text()).toContain('<meta name="robots" content="noindex">')
})

it('disables the names sitemap while preserving link preview images', async () => {
  vi.stubEnv('DUSK_DOMAINS_NOINDEX', 'true')
  const { baseUrl } = await fixture()
  const sitemap = await fetch(baseUrl + '/sitemap/names.xml')
  expect(sitemap.status).toBe(404)
  expect(await sitemap.text()).not.toContain('<urlset')
  for (const name of ['aurora.dusk', 'unknown.dusk']) {
    const png = await fetch(`${baseUrl}/share/name/${name}.png`)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await png.arrayBuffer()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
})

it('keeps mainnet pages and the names sitemap indexable when noindex is false', async () => {
  vi.stubEnv('DUSK_DOMAINS_NOINDEX', 'false')
  const { baseUrl } = await fixture()
  for (const path of ['/share/name/aurora.dusk', '/page/name/aurora.dusk', '/sitemap/names.xml']) {
    const response = await fetch(baseUrl + path)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-robots-tag')).toBeNull()
    expect(await response.text()).not.toContain('content="noindex"')
  }
})

it('normalizes the configured HTTP origin and rejects unsupported URL schemes', () => {
  expect(siteConfig({})).toEqual({ origin: 'https://dusk.domains', host: 'dusk.domains', noindex: false })
  expect(siteConfig({ DUSK_DOMAINS_SITE_URL: 'https://testnet.dusk.domains:9443/path?q=1#fragment' })).toMatchObject({
    origin: 'https://testnet.dusk.domains:9443', host: 'testnet.dusk.domains:9443',
  })
  expect(() => siteConfig({ DUSK_DOMAINS_SITE_URL: 'ftp://testnet.dusk.domains' })).toThrow('must use HTTP or HTTPS')
})

it("retains each running handler's origin and indexing policy", async () => {
  const mainnet = await fixture()
  vi.stubEnv('DUSK_DOMAINS_SITE_URL', 'https://testnet.dusk.domains')
  vi.stubEnv('DUSK_DOMAINS_NOINDEX', 'true')
  const testnet = await fixture()
  for (const [server, origin, robots] of [
    [mainnet, 'https://dusk.domains', null], [testnet, 'https://testnet.dusk.domains', 'noindex'],
  ]) {
    const response = await fetch(server.baseUrl + '/share/name/aurora.dusk')
    expect(response.headers.get('x-robots-tag')).toBe(robots)
    expect(await response.text()).toContain(`<link rel="canonical" href="${origin}/name/aurora.dusk">`)
  }
})
