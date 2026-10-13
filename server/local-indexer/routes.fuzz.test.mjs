import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { createLocalIndexerHandler } from './routes.mjs'
import { createWebsiteVerification } from './website-verification.mjs'
import { LOCAL_INDEXER_ROUTE_LIST } from './http.mjs'
import { LIST_FIELDS } from './pagination.mjs'
import { replayEventLog } from './event-log-store.mjs'
import { populationEntries } from '../../scripts/test-fixtures/frozen-population.mjs'
import { rootNode, id, address } from '../../scripts/test-fixtures/frozen-events.mjs'
import { check, count, testTimeout } from '../../scripts/test-fixtures/fuzz-support.mjs'

// Arbitrary paths, query strings, methods and bodies against a real HTTP server
// on an ephemeral port (port 0), over a replayed 211-name population. Website
// verification is mocked here and fuzzed separately with adversarial DNS
// answers below; no test contacts a network resolver.
vi.setConfig({ testTimeout })
const REQUEST_TIMEOUT_MS = Number(process.env.FUZZ_REQUEST_TIMEOUT_MS ?? 15_000)
let server, base, clock = 0
const failures = []
beforeAll(async () => {
  const warnings = [], store = replayEventLog([...populationEntries(210)], warnings, '2026-10-07T12:00:00Z', 400)
  expect(warnings).toEqual([])
  server = createServer(createLocalIndexerHandler(store, {
    rateLimit: false, now: () => clock, corsOrigin: 'https://app.example',
    verification: { read: () => ({ domain: null, status: 'unverified', checkedAt: null, dnssec: false }),
      check: async () => ({ domain: null, status: 'unverified', checkedAt: null, dnssec: false }) },
    indexNow: { enabled: true, key: 'property-test-key' },
    logger: { warn() {}, error(value) { failures.push(value) } },
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
}, 60_000)
afterAll(async () => {
  if (!server) return
  await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
})

function send(path, method = 'GET', body = '', headers = {}) {
  clock += 61_000 // Per-name and per-IP verification windows must not mask validation.
  const bodyless = ['GET', 'HEAD', 'OPTIONS'].includes(method)
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers: { ...(bodyless ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }), ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }))
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Request hung for ${REQUEST_TIMEOUT_MS} ms: ${method} ${path}`)))
    req.on('error', reject)
    req.end(bodyless ? undefined : body)
  })
}
const text = fc.oneof(fc.string({ maxLength: 70 }), fc.string({ unit: 'binary', maxLength: 40 }),
  fc.constantFrom('', '0', '1', '-1', '01', '1.5', '1e3', '200', '201', '9007199254740993', '18446744073709551615', 'é', '界', '😀',
    'population0.dusk', 'POPULATION1', 'x.aurora.dusk', `0x${id(10)}`, `0X${id(10).toUpperCase()}`, id(10), address, rootNode, '%', '\u0000', 'a'.repeat(5000)))
const parameters = fc.array(fc.tuple(fc.constantFrom('node', 'name', 'parentNode', 'query', 'owner', 'key', 'type', 'value', 'referrer',
  'buyerAuthority', 'authority', 'commitment', 'controller', 'marketplace', 'orderId', 'limit', 'cursor', 'unknown', ''), text), { maxLength: 6 })
const defaultQuery = {
  node: rootNode, parentNode: rootNode, name: 'population0.dusk', query: 'population',
  key: 'moonlight_address', type: 'moonlight_address', value: address, referrer: `Contract:${id(13)}`,
  buyerAuthority: `0x${id(14)}`, authority: `0x${id(10)}`, commitment: `0x${id(20)}`,
}
// Documented client errors (docs/indexer-api.md). Every other status or shape fails.
const errors = new Set(['missing_node', 'invalid_node', 'missing_authority', 'invalid_authority', 'missing_commitment',
  'invalid_commitment', 'invalid_controller', 'missing_record_key', 'invalid_record_key', 'missing_endpoint', 'unsupported_endpoint_type',
  'invalid_limit', 'invalid_cursor', 'invalid_marketplace', 'invalid_order_id', 'invalid_name', 'name_not_found',
  'method_not_allowed', 'not_found', 'rate_limited', 'invalid_url', 'invalid_referrer'])

function assertResponse(response, requested, limit = 200) {
  // The server ignores trailing slashes; check against the route it served.
  const path = requested.replace(/\/+$/, '') || '/'
  expect(response.status, path).toBeLessThan(500)
  expect(failures).toEqual([])
  expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/)
  if (response.status === 204) return
  if (!response.headers['content-type']?.includes('application/json')) {
    expect([200, 404]).toContain(response.status)
    return
  }
  const body = JSON.parse(response.bytes.toString())
  if (response.status >= 400) {
    if (Array.isArray(body?.errors)) {
      expect(path).toBe('/resolve')
      expect(body.node).toBe('0x')
      expect(body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_name' })]))
    } else {
      expect(errors.has(body?.error), JSON.stringify(body)).toBe(true)
      expect(Object.keys(body).every(key => ['error', 'message', 'parameter', 'type'].includes(key)), JSON.stringify(body)).toBe(true)
      if (body.message !== undefined) expect(typeof body.message).toBe('string')
    }
  } else if (LIST_FIELDS[path]) {
    expect(Array.isArray(body[LIST_FIELDS[path]])).toBe(true)
    expect(body[LIST_FIELDS[path]].length).toBeLessThanOrEqual(limit)
    expect(body.nextCursor === null || typeof body.nextCursor === 'string').toBe(true)
  }
  return body
}

const methods = ['GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']
for (const path of LOCAL_INDEXER_ROUTE_LIST) it(`routes ${path}: arbitrary queries, methods and bodies stay within response contracts`, async () => {
  const metrics = {}
  await check(`routes/${path}`, fc.asyncProperty(parameters, fc.boolean(), fc.jsonValue({ maxDepth: 2 }), fc.nat(), fc.boolean(),
    async (pairs, useDefaults, body, verb, origin) => {
      const query = new URLSearchParams(useDefaults ? defaultQuery : {})
      for (const [key, value] of pairs) query.append(key, value)
      const method = path === '/verify' && verb % 3 === 0 ? 'POST' : methods[verb % methods.length]
      const response = await send(`${path}?${query}`, method, JSON.stringify(body), origin ? { origin: 'https://app.example' } : {})
      count(metrics, String(response.status))
      if (method !== 'HEAD') assertResponse(response, path)
      else expect(response.status).toBeLessThan(500)
    }), { examples: [[[], true, null, 0, false], [[], false, {}, 0, true]], metrics })
})

// Path components (share cards, crawler pages, IndexNow, every JSON route) with
// raw percent sequences, separators and dot segments.
const segment = fc.oneof(text.map(encodeURIComponent), fc.stringMatching(/^[A-Za-z0-9%._~!$&'()*+,;=:@/-]{0,40}$/),
  fc.constantFrom('%', '%E0%A4%A', '%00', '%2F', '%2e%2e', '..', '.', '//', '%C0%AF', 'population0.dusk', 'population0.dusk.png', 'aurora.png'))
const prefixes = ['/share/name/', '/page/name/', '/sitemap/names.xml', '/indexnow/', '/indexnow/property-test-key.txt', '/unknown/', '/',
  ...LOCAL_INDEXER_ROUTE_LIST.map(path => `${path}/`)]
it('paths: arbitrary path components on every route prefix', async () => {
  const metrics = {}
  await check('paths/all-prefixes', fc.asyncProperty(fc.constantFrom(...prefixes), segment, fc.boolean(), parameters, async (prefix, part, png, pairs) => {
    const target = `${prefix}${part}${png ? '.png' : ''}`
    const response = await send(`${target}?${new URLSearchParams(pairs)}`)
    count(metrics, `${prefix.split('/')[1] || 'root'}:${response.status}`)
    // Prefixing the actual origin preserves a leading `//` as a path. Passing
    // that target as a relative URL would instead parse it as a host-relative
    // URL and make the test oracle throw before inspecting the response.
    assertResponse(response, new URL(base + target).pathname)
  }), { metrics, examples: [['/share/name/', 'population0.dusk', true, []], ['/page/name/', '%E0%A4%A', false, []]] })
})

// Pagination for every list route: bounded pages, disjoint and complete traversal.
const listRoutes = Object.keys(LIST_FIELDS).map(path => [path,
  ['/records', '/activity', '/record-history'].includes(path) ? { node: rootNode }
    : path === '/subnames' ? { parentNode: rootNode } : path === '/holdings' ? { authority: `0x${id(10)}` }
      : path === '/marketplace/refunds' ? { authority: `0x${id(14)}` } : {}])
async function traverse(path, filters, limit) {
  const rows = [], seen = new Set()
  let cursor = null, pages = 0
  do {
    const query = new URLSearchParams({ ...filters, limit: String(limit) })
    if (cursor !== null) query.set('cursor', cursor)
    const body = assertResponse(await send(`${path}?${query}`), path, Math.min(limit, 200))
    expect(body, path).toBeTruthy()
    for (const row of body[LIST_FIELDS[path]]) {
      const key = JSON.stringify(row)
      expect(seen.has(key), `${path} repeated a row`).toBe(false)
      seen.add(key); rows.push(row)
    }
    cursor = body.nextCursor
    expect(++pages).toBeLessThanOrEqual(1000)
  } while (cursor !== null)
  return { rows, pages }
}
const reference = new Map()
for (const [path, filters] of listRoutes) it(`pagination ${path}: bounded, disjoint and complete pages for any limit`, async () => {
  const metrics = {}
  if (!reference.has(path)) reference.set(path, (await traverse(path, filters, 200)).rows)
  const all = reference.get(path)
  await check(`pagination${path}`, fc.asyncProperty(fc.integer({ min: 1, max: 400 }), async limit => {
    const { rows, pages } = await traverse(path, filters, limit)
    expect(rows).toEqual(all)
    expect(pages).toBeLessThanOrEqual(Math.max(1, Math.ceil(all.length / Math.min(limit, 200))) + 1)
    count(metrics, `rows:${all.length}`)
  }), { weight: 0.5, metrics, examples: [[1], [199], [200], [201]] })
})

// Cursor tampering: edited, truncated or foreign cursors are rejected as invalid_cursor, never 5xx.
it('pagination cursors: tampered and foreign cursors stay client errors', async () => {
  const first = assertResponse(await send('/names?limit=3'), '/names', 3)
  const valid = first.nextCursor
  expect(typeof valid).toBe('string')
  const metrics = {}
  await check('pagination/cursor-tampering', fc.asyncProperty(fc.nat(), fc.nat(), fc.constantFrom(...Object.keys(LIST_FIELDS), '/search', '/health', '/resolve'),
    fc.constantFrom('flip', 'truncate', 'extend', 'foreign', 'filter'), async (at, value, path, op) => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/.'
      let cursor = valid, target = '/names', extra = {}
      if (op === 'flip') cursor = valid.slice(0, at % valid.length) + alphabet[value % alphabet.length] + valid.slice(at % valid.length + 1)
      if (op === 'truncate') cursor = valid.slice(0, at % valid.length)
      if (op === 'extend') cursor = valid + alphabet[value % alphabet.length].repeat(1 + (at % 5000))
      if (op === 'foreign') target = path
      if (op === 'filter') extra = { owner: `0x${id(value % 255)}` }
      const response = await send(`${target}?${new URLSearchParams({ ...defaultQuery, ...extra, cursor, limit: '3' })}`)
      count(metrics, `${op}:${response.status}`)
      const body = assertResponse(response, target, 3)
      if (response.status >= 400 && body?.error) expect(['invalid_cursor', 'invalid_node', 'invalid_authority', 'missing_record_key', 'invalid_record_key', 'invalid_referrer']).toContain(body.error)
    }), { metrics })
})

// POST /verify against the real verification service with adversarial DNS-over-HTTPS answers.
const node = `0x${'aa'.repeat(32)}`, owner = `0x${'11'.repeat(32)}`
const proof = `dusk-domains-verification=aurora.dusk;owner=${owner}`
function verifyFixture() {
  const lifecycle = { node, canonicalName: 'aurora.dusk', owner, manager: owner, status: 'active', resolverId: 'resolver' }
  const records = [{ key: 'website', value: 'https://harbourline.com', updatedAt: '2026-10-01' }]
  return { namesByNode: new Map([[node, lifecycle]]), namesByCanonical: new Map([['aurora.dusk', { ...lifecycle, lifecycle, records }]]),
    recordsByNode: new Map([[node, records]]), subnamesByNode: new Map(), subnamesByCanonical: new Map(), subnamesByParent: new Map(),
    activityByNode: new Map(), reverseByEndpoint: new Map() }
}
const txtData = fc.oneof(fc.constant(JSON.stringify(proof)), fc.constant(`"${proof.slice(0, 30)}" "${proof.slice(30)}"`),
  fc.constant(JSON.stringify(proof.replace('aurora', 'other'))), fc.string({ maxLength: 80 }), fc.jsonValue({ maxDepth: 1 }),
  fc.constant(`"${'\\'.repeat(3)}"`), fc.constant(`"\\999"`), fc.constant('"x'.repeat(4000)))
const answerRow = fc.oneof(fc.record({
  name: fc.oneof(fc.constantFrom('_dusk-domains.harbourline.com.', '_DUSK-DOMAINS.HARBOURLINE.COM', '_dusk-domains.harbourline.com'), fc.string()),
  type: fc.oneof(fc.constant(16), fc.integer(), fc.string()), TTL: fc.oneof(fc.integer({ min: -10, max: 10 ** 9 }), fc.double(), fc.string()),
  data: txtData,
}, { requiredKeys: [] }), fc.jsonValue({ maxDepth: 1 }))
const proofRow = fc.record({ name: fc.constant('_dusk-domains.harbourline.com.'), type: fc.constant(16), TTL: fc.integer({ min: 0, max: 86400 }), data: txtData })
const dnsBody = fc.oneof(
  { weight: 3, arbitrary: fc.record({ Status: fc.constant(0), AD: fc.boolean(), Answer: fc.array(fc.oneof(proofRow, answerRow), { maxLength: 4 }) }) },
  { weight: 1, arbitrary: fc.record({
    Status: fc.oneof(fc.constantFrom(0, 3, 2, 5), fc.jsonValue({ maxDepth: 0 })), AD: fc.oneof(fc.boolean(), fc.jsonValue({ maxDepth: 0 })),
    Answer: fc.oneof(fc.array(answerRow, { maxLength: 6 }), fc.jsonValue({ maxDepth: 1 })),
  }, { requiredKeys: [] }) })
const dns = fc.oneof(
  fc.record({ kind: fc.constant('json'), status: fc.constantFrom(200, 200, 200, 404, 500, 503), body: fc.oneof(dnsBody, fc.jsonValue({ maxDepth: 2 })) }),
  fc.record({ kind: fc.constant('bytes'), bytes: fc.uint8Array({ maxLength: 256 }) }),
  fc.constantFrom({ kind: 'throw' }, { kind: 'abort' }, { kind: 'huge' }, { kind: 'empty' }, { kind: 'slow-body' }))
function respond(behavior, signal) {
  if (behavior.kind === 'throw') throw new TypeError('fetch failed')
  if (behavior.kind === 'abort') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  if (behavior.kind === 'huge') return new Response(JSON.stringify({ Status: 0, Answer: [{ data: 'x'.repeat(70_000) }] }))
  if (behavior.kind === 'empty') return new Response(null, { status: 200 })
  if (behavior.kind === 'bytes') return new Response(behavior.bytes)
  if (behavior.kind === 'slow-body') return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"Status":0,'))
    signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
  } }))
  return new Response(JSON.stringify(behavior.body), { status: behavior.status, headers: { 'content-type': 'application/dns-json' } })
}
function invoke(handler, url, method = 'POST') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Handler hung: ${method} ${url}`)), REQUEST_TIMEOUT_MS)
    let status, headers
    handler({ url, method, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, {
      writeHead(s, h) { status = s; headers = h },
      end(body) { clearTimeout(timer); resolve({ status, headers, body: body ? JSON.parse(body) : null }) },
    })
  })
}
it('POST /verify: adversarial DNS answers give documented statuses and verification shapes', async () => {
  const metrics = {}
  await check('routes/verify-dns', fc.asyncProperty(fc.array(dns, { minLength: 2, maxLength: 2 }),
    fc.oneof({ weight: 4, arbitrary: fc.constantFrom('aurora', 'AURORA.DUSK', 'aurora.dusk', ' aurora ') },
      fc.constantFrom('missing', 'bad/name', '', 'xn--aurora', 'a'.repeat(300)), fc.string({ maxLength: 20 })), fc.nat(9),
    async ([primary, fallback], name, repeat) => {
      const duplicate = repeat === 0
      let time = Date.parse('2026-10-10T00:00:00Z'), calls = 0, redirects = true
      const store = verifyFixture()
      const fetcher = async (url, init) => {
        calls++
        redirects &&= init.redirect === 'error' && init.signal instanceof AbortSignal
        return respond(new URL(url).hostname === '1.1.1.1' ? primary : fallback, init.signal)
      }
      const verification = createWebsiteVerification(() => store, { fetcher, timeoutMs: 25, now: () => time })
      const handler = createLocalIndexerHandler(() => store, { now: () => time, verification })
      const query = new URLSearchParams([['name', name], ...(duplicate ? [['name', name]] : [])])
      const response = await invoke(handler, `/verify?${query}`)
      count(metrics, `${response.status}:${response.body?.verification?.status ?? response.body?.error}`)
      expect([200, 400, 404, 429, 503]).toContain(response.status)
      if (response.status === 503) expect(response.body.error).toBe('verification_busy')
      if (response.status !== 200) {
        expect(errors.has(response.body.error) || response.body.error === 'verification_busy').toBe(true)
        return
      }
      expect(Object.keys(response.body).sort()).toEqual(['canonicalName', 'verification'])
      const v = response.body.verification
      expect(Object.keys(v).sort()).toEqual(['checkedAt', 'dnssec', 'domain', 'status'])
      expect(['verified', 'unverified', 'mismatch', 'checking', 'retry']).toContain(v.status)
      expect(v.checkedAt === null || new Date(v.checkedAt).toISOString() === v.checkedAt).toBe(true)
      expect(typeof v.dnssec).toBe('boolean')
      expect(calls).toBeLessThanOrEqual(2)
      expect(redirects).toBe(true)
      // Oracles for clear-cut answers: an exact proof from the first resolver verifies; two failures never do.
      if (primary.kind === 'json' && primary.status === 200 && primary.body?.Status === 0 && Array.isArray(primary.body?.Answer)
        && primary.body.Answer.every(row => row !== null) && primary.body.Answer.some(row => row && row.type === 16 && row.name === '_dusk-domains.harbourline.com.' && row.data === JSON.stringify(proof)))
        expect(v.status).toBe('verified')
      if (['throw', 'abort', 'huge', 'empty'].includes(primary.kind) && ['throw', 'abort', 'huge', 'empty'].includes(fallback.kind))
        expect(v.status).toBe('unverified')
      verification.stop()
    }), { metrics, weight: 2 })
})
