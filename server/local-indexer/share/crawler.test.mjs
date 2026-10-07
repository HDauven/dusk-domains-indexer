import { blake2b } from '@noble/hashes/blake2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { encodeBase58 as bytesToBase58 } from '@duskdomains/sdk'
import { afterEach, expect, it } from 'vitest'
import { createEventLog, envelope, receipt, rootName, ref, bytes, order } from '../../../scripts/test-fixtures/frozen-events.mjs'
import { replayEventLog } from '../event-log-store.mjs'
import { loadSnapshotStore } from '../../local-indexer.mjs'
import { createSnapshot, startServer, writeSnapshot } from '../../local-indexer-test-helpers.mjs'
import { nameValidationIssue } from '../naming.mjs'
import { nameOwnerAddress, namesSitemap, ownerAddress, recordLabel } from './crawler.mjs'

const servers = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const key = Uint8Array.from({ length: 96 }, (_, index) => index + 7)
const address = bytesToBase58(Array.from(key))
const authority = `0x${bytesToHex(blake2b(concatBytes(utf8ToBytes('dusk-domains:runtime-authority:v1'), key), { dkLen: 32 }))}`

async function fixture(overrides = {}) {
  const store = await loadSnapshotStore(await writeSnapshot(createSnapshot(overrides)))
  const server = await startServer(store)
  servers.push(server)
  return { ...server, store }
}

it('derives the owner address only from an address that hashes to the authority', () => {
  expect(ownerAddress(authority, ['not-base58-0OIl', address])).toBe(address)
  expect(ownerAddress(`0x${'ab'.repeat(32)}`, [address])).toBeNull()
  expect(ownerAddress('not an authority', [address])).toBeNull()
})

it('lists registered names and subnames with their latest activity', async () => {
  const { baseUrl } = await fixture({ owner: authority })
  const response = await fetch(`${baseUrl}/sitemap/names.xml`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('public, max-age=300')
  const xml = await response.text()
  expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
  expect(xml).toContain('<loc>https://dusk.domains/name/aurora.dusk</loc>\n    <lastmod>2026-06-17T00:00:00.000Z</lastmod>')
  expect(xml).toContain('<loc>https://dusk.domains/name/settlement.aurora.dusk</loc>')
})

it('leaves expired names and their subnames out of the sitemap', async () => {
  const { baseUrl, store } = await fixture({ owner: authority, nameOverrides: { expiresAtBlockHeight: 100 } })
  store.currentBlockHeight = 100
  store.cursor = { lastBlockHeight: 100 }
  const xml = await (await fetch(`${baseUrl}/sitemap/names.xml`)).text()
  expect(xml).not.toContain('aurora.dusk')
})

it('serves the name page facts as plain HTML at the canonical URL without redirecting', async () => {
  const { baseUrl } = await fixture({
    owner: authority,
    records: [
      { key: 'moonlight_address', value: address, visibility: 'public' },
      { key: 'website', value: 'https://aurora.example/', visibility: 'public' },
      { key: 'content_pointer', value: 'ipfs://<script>alert(1)</script>', visibility: 'public' },
      { key: 'text.description', value: 'Aurora & friends', visibility: 'public' },
      { key: 'text.private', value: 'hidden', visibility: 'private' },
    ],
  })
  const response = await fetch(`${baseUrl}/page/name/Aurora.dusk`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  const html = await response.text()
  expect(html).toContain('<h1>aurora.dusk</h1>')
  expect(html).toContain('<p>Aurora &amp; friends</p>')
  expect(html).toContain(`<dt>Owner</dt><dd><code>${address}</code></dd>`)
  expect(html).toContain('<dt>Expires</dt><dd>2027-06-17</dd>')
  expect(html).toContain('<dt>Website</dt><dd><a href="https://aurora.example/" rel="nofollow ugc noopener">')
  expect(html).toContain('<dt>Content pointer</dt><dd><code>ipfs://&lt;script&gt;alert(1)&lt;/script&gt;</code></dd>')
  expect(html).toContain('<a href="https://dusk.domains/name/settlement.aurora.dusk">settlement.aurora.dusk</a>')
  expect(html).toContain('<link rel="canonical" href="https://dusk.domains/name/aurora.dusk">')
  expect(html).toContain('<meta name="robots" content="index,follow">')
  expect(html).toContain('<meta property="og:image" content="https://dusk.domains/api/share/name/aurora.dusk.png">')
  expect(html).not.toMatch(/http-equiv="refresh"|<script|hidden/)
})

it('shows the owner ID when no known address belongs to the owner', async () => {
  const { baseUrl } = await fixture({ owner: `0x${'ab'.repeat(32)}`, records: [{ key: 'moonlight_address', value: address, visibility: 'public' }] })
  const html = await (await fetch(`${baseUrl}/page/name/aurora.dusk`)).text()
  expect(html).toContain(`<dt>Owner</dt><dd><code>0x${'ab'.repeat(32)}</code> (owner ID)</dd>`)
})

it.each([
  ['unknown.dusk', 200, 'This name is not registered.'],
  ['-bad.dusk', 404, 'This is not a valid .dusk name.'],
  ['%E0%A4%A', 404, 'This is not a valid .dusk name.'],
])('serves a plain page that is not indexed for %s', async (name, status, text) => {
  const { baseUrl } = await fixture({ owner: authority })
  const response = await fetch(`${baseUrl}/page/name/${name}`)
  expect(response.status).toBe(status)
  const html = await response.text()
  expect(html).toContain(text)
  expect(html).toContain('<meta name="robots" content="noindex,follow">')
  expect(html).not.toContain('-bad')
})

// Map iteration that counts full scans, to show what is indexed rather than rescanned.
class CountingMap extends Map {
  constructor(entries) {
    super(entries)
    this.scans = 0
  }

  [Symbol.iterator]() {
    this.scans += 1
    return super[Symbol.iterator]()
  }

  values() {
    this.scans += 1
    return super.values()
  }
}

function sitemapStore(names, activity = new CountingMap()) {
  const byCanonical = new Map(names.map((name) => [name.canonicalName, name]))
  return {
    namesByCanonical: byCanonical,
    namesByNode: new Map(names.map((name) => [name.node, name])),
    subnamesByCanonical: new Map(),
    subnamesByNode: new Map(),
    activityByNode: activity,
  }
}

const root = (canonicalName, node, expiresAtBlockHeight = 1_000) => ({ canonicalName, node, owner: authority, status: 'active', expiresAtBlockHeight })

it('labels records with keys that Object.prototype also uses', async () => {
  expect(recordLabel('constructor')).toBe('Constructor')
  expect(recordLabel('hasOwnProperty')).toBe('HasOwnProperty')
  const { baseUrl } = await fixture({
    owner: authority,
    records: [
      { key: 'constructor', value: 'one', visibility: 'public' },
      { key: 'toString', value: 'two', visibility: 'public' },
      { key: 'website', value: 'https://aurora.example/', visibility: 'public' },
    ],
  })
  const response = await fetch(`${baseUrl}/page/name/aurora.dusk`)
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('<dt>Constructor</dt><dd><code>one</code></dd>')
  expect(html).toContain('<dt>ToString</dt><dd><code>two</code></dd>')
})

it('indexes activity once per read model and rebuilds the sitemap only when the height changes', () => {
  const activity = new CountingMap([['0x01', [{ timestamp: '2026-10-01T00:00:00.000Z' }, { timestamp: '2026-10-03T00:00:00.000Z' }]]])
  const store = sitemapStore([root('older.dusk', '0x02'), root('newer.dusk', '0x01', 150)], activity)
  const date = new Date('2026-10-05T00:00:00.000Z')
  const first = namesSitemap(store, { blockHeight: 100, date })
  expect(namesSitemap(store, { blockHeight: 100, date })).toBe(first)
  expect(first.indexOf('newer.dusk')).toBeLessThan(first.indexOf('older.dusk'))
  expect(first).toContain('<loc>https://dusk.domains/name/newer.dusk</loc>\n    <lastmod>2026-10-03T00:00:00.000Z</lastmod>')
  // newer.dusk expires at block 150: a later height filters it without rescanning activity.
  const later = namesSitemap(store, { blockHeight: 200, date })
  expect(later).not.toContain('newer.dusk')
  expect(later).toContain('older.dusk')
  expect(activity.scans).toBe(1)
})

it('lists only names that the name page accepts', () => {
  const tooLong = `${'a'.repeat(64)}.dusk`
  expect(nameValidationIssue(tooLong)).not.toBeNull()
  const xml = namesSitemap(sitemapStore([root(tooLong, '0x03'), root('fine.dusk', '0x04')]), { blockHeight: 1, date: new Date() })
  expect(xml).not.toContain(tooLong)
  expect(xml).toContain('fine.dusk')
})

it('finds the owner address in the name itself before indexing primary names by authority', () => {
  const reverse = new CountingMap([['moonlight_address:x', { endpoint: { type: 'moonlight_address', value: address }, controller: authority }]])
  const store = { activityByNode: new Map(), reverseByEndpoint: reverse }
  const name = { node: '0x05', owner: authority }
  expect(nameOwnerAddress(store, name, [{ key: 'moonlight_address', value: address }])).toBe(address)
  expect(reverse.scans).toBe(0)
  expect(nameOwnerAddress(store, name, [])).toBe(address)
  expect(nameOwnerAddress(store, { node: '0x06', owner: authority.toUpperCase() }, [])).toBe(address)
  expect(reverse.scans).toBe(1)
})

it('says a name in grace has expired and can still be renewed, and keeps it out of the index', async () => {
  const { baseUrl, store } = await fixture({
    owner: authority,
    nameOverrides: { expiresAtBlockHeight: 100, graceEndsAtBlockHeight: 300 },
  })
  store.currentBlockHeight = 200
  store.cursor = { lastBlockHeight: 200 }
  const response = await fetch(`${baseUrl}/page/name/aurora.dusk`)
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('<p>aurora.dusk expired on 2027-06-17. Its owner, or anyone else, can renew it until 2027-07-17.</p>')
  expect(html).toContain('<meta name="robots" content="noindex,follow">')
  expect(html).not.toContain('not registered')
  const subname = await (await fetch(`${baseUrl}/page/name/settlement.aurora.dusk`)).text()
  expect(subname).toContain('<p>settlement.aurora.dusk is not active, because aurora.dusk has expired.</p>')

  store.currentBlockHeight = 400
  store.cursor = { lastBlockHeight: 400 }
  const after = await (await fetch(`${baseUrl}/page/name/aurora.dusk`)).text()
  expect(after).toContain('<p>aurora.dusk expired on 2027-06-17. Anyone can register it again.</p>')
})

it('picks up names registered after the first request when the read model keeps its maps', () => {
  const store = { ...sitemapStore([root('first.dusk', '0x11')]), checkpoint: { eventCount: 1 } }
  const date = new Date('2026-10-05T00:00:00.000Z')
  expect(namesSitemap(store, { blockHeight: 10, date })).not.toContain('second.dusk')
  // An incremental replay adds to the same maps and bumps the event count.
  const second = root('second.dusk', '0x12')
  store.namesByCanonical.set(second.canonicalName, second)
  store.namesByNode.set(second.node, second)
  store.activityByNode.set('0x12', [{ timestamp: '2026-10-04T00:00:00.000Z' }])
  store.checkpoint = { eventCount: 2 }
  const xml = namesSitemap(store, { blockHeight: 10, date })
  expect(xml).toContain('<loc>https://dusk.domains/name/second.dusk</loc>\n    <lastmod>2026-10-04T00:00:00.000Z</lastmod>')
})

it('drops a name that expires by date even while the height stays the same', () => {
  const dated = { canonicalName: 'dated.dusk', node: '0x13', owner: authority, status: 'active', expiresAt: '2026-10-05T00:01:00.000Z' }
  const store = sitemapStore([dated])
  expect(namesSitemap(store, { blockHeight: 10, date: new Date('2026-10-05T00:00:00.000Z') })).toContain('dated.dusk')
  expect(namesSitemap(store, { blockHeight: 10, date: new Date('2026-10-05T00:02:00.000Z') })).not.toContain('dated.dusk')
})

it('allows permissionless renewal during frozen marketplace custody until grace ends', async () => {
  const name = rootName(), custody = { nonce: 4n, incarnation: name.incarnation, custodian: bytes(6),
    origin_owner: name.owner, origin_manager: name.manager }
  const entries = [...createEventLog(), envelope(receipt(16, [
    [4, 'authorities_changed', { name: { ...name, owner: bytes(6), manager: bytes(6), custody }, actor: name.owner,
      previous_owner: name.owner, previous_manager: name.manager, data_cleared: false, reason: 'Holder' }],
    [4, 'custody_started', { name: ref(name), custody, callback_data_hash: bytes(0) }],
    [6, 'order_changed', { order: order() }],
  ]))]
  const warnings = [], store = replayEventLog(entries, warnings, new Date().toISOString(), 1500)
  expect(warnings).toEqual([])
  expect(store.marketplaceFixedSalesByNode.values().next().value.escrowed).toBe(true)
  const server = await startServer(store); servers.push(server)
  const html = await (await fetch(`${server.baseUrl}/page/name/aurora.dusk`)).text()
  expect(html).toContain('<p>aurora.dusk has expired. Its owner, or anyone else, can renew it until its grace period ends.</p>')
  expect(html).toContain('<meta name="robots" content="noindex,follow">')
  expect(html).not.toContain('cannot be renewed')
  // At grace end the lifecycle is released, even while custody history remains.
  Object.assign(store, replayEventLog(entries, [], new Date().toISOString(), 2000))
  const after = await (await fetch(`${server.baseUrl}/page/name/aurora.dusk`)).text()
  expect(after).not.toContain('can renew it')
})

it('explains a root past grace that only its lifecycle still records', async () => {
  const { crawlerPage } = await import('./crawler.mjs')
  const lapsed = { canonicalName: 'gone.dusk', node: '0x21', owner: authority, status: 'expired', expiresAt: '2026-01-01T00:00:00.000Z', graceEndsAt: '2026-01-31T00:00:00.000Z' }
  const store = {
    namesByCanonical: new Map(),
    namesByNode: new Map(),
    subnamesByCanonical: new Map(),
    subnamesByNode: new Map(),
    lifecyclesByCanonical: new Map([['gone.dusk', lapsed]]),
    recordsByNode: new Map(),
  }
  const { status, html } = crawlerPage(store, 'gone.dusk', { date: new Date('2026-10-05T00:00:00.000Z') }, 'Dusk Domains')
  expect(status).toBe(200)
  expect(html).toContain('<p>gone.dusk expired on 2026-01-01. Anyone can register it again.</p>')
  expect(html).not.toContain('not registered')
})
