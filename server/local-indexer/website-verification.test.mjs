import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebsiteVerification, parseTxt, websiteDomain } from './website-verification.mjs'
import { createLocalIndexerHandler } from './routes.mjs'

const node = `0x${'aa'.repeat(32)}`
const owner = `0x${'11'.repeat(32)}`
const txt = (name = 'aurora.dusk', authority = owner) => `dusk-domains-verification=${name};owner=${authority}`
const answer = (value = txt(), extra = {}) => Response.json({ Status: 0, AD: true,
  Answer: [{ name: '_dusk-domains.harbourline.com.', type: 16, TTL: 21600, data: JSON.stringify(value) }], ...extra })
function fixture() {
  const lifecycle = { node, canonicalName: 'aurora.dusk', owner, manager: owner, status: 'active', resolverId: 'resolver' }
  const records = [{ key: 'website', value: 'https://harbourline.com', updatedAt: '2026-10-01' }]
  return { namesByNode: new Map([[node, lifecycle]]), namesByCanonical: new Map([['aurora.dusk', { ...lifecycle, lifecycle, records }]]),
    recordsByNode: new Map([[node, records]]), subnamesByNode: new Map(), subnamesByCanonical: new Map(), subnamesByParent: new Map(),
    activityByNode: new Map(), reverseByEndpoint: new Map() }
}
const request = (handler, url, method = 'GET', ip = '127.0.0.1', headers = {}) => new Promise(resolve => {
  let status, responseHeaders
  handler({ url, method, headers, socket: { remoteAddress: ip } }, {
    writeHead(s, h) { status = s; responseHeaders = h },
    end(body) { resolve({ status, headers: responseHeaders, body: body ? JSON.parse(body) : null }) },
  })
})
afterEach(() => vi.useRealTimers())

describe('website domains and DNS TXT presentation', () => {
  it.each(['https://harbourline.com', 'https://HARBOURLINE.com/about?q=1', 'https://www.harbourline.com/path', 'https://xn--bcher-kva.example'])('accepts %s', value => {
    expect(websiteDomain(value)).toBe(new URL(value).hostname)
  })
  it.each(['', 'http://harbourline.com', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]',
    'https://harbourline.com:443', 'https://harbourline.com:8443', 'https://user@harbourline.com',
    'https://localhost', 'https://bad_host.com', 'https://-bad.com', 'https://bad-.com', 'https://a..com',
    'https://harbourline.com.', 'https://%68arbourline.com', ' https://harbourline.com', 'https://harbourline.com\n',
    'https://harbourline.com\\evil', `https://${'a'.repeat(64)}.com`, `https://${Array(4).fill('a'.repeat(60)).join('.')}`])('rejects %s', value => {
    expect(websiteDomain(value)).toBeNull()
  })
  it('joins quoted chunks and decodes DNS escapes without normalizing the value', () => {
    expect(parseTxt('"dusk-domains-verification=aurora.dusk;" "owner=0x11"')).toBe('dusk-domains-verification=aurora.dusk;owner=0x11')
    expect(parseTxt('"a\\032b\\\"c\\\\d"')).toBe('a b"c\\d')
    expect(parseTxt('" value "')).toBe(' value ')
    for (const value of ['"unterminated', '"ok" junk', '"\\999"', 'plain', '']) expect(parseTxt(value)).toBeNull()
  })
})

describe('two-way website verification', () => {
  it('uses only fixed resolvers and matches the exact name and indexed owner', async () => {
    const store = fixture(), fetcher = vi.fn(async () => answer())
    const service = createWebsiteVerification(() => store, { fetcher })
    expect(service.read(store, node)).toEqual({ domain: 'harbourline.com', status: 'unverified', checkedAt: null, dnssec: false })
    expect(await service.check(node)).toMatchObject({ domain: 'harbourline.com', status: 'verified', dnssec: true, checkedAt: expect.any(String) })
    const [url, options] = fetcher.mock.calls[0]
    expect(new URL(url).origin + new URL(url).pathname).toBe('https://1.1.1.1/dns-query')
    expect(new URL(url).searchParams.get('name')).toBe('_dusk-domains.harbourline.com')
    expect(options.redirect).toBe('error')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    await service.tick()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each([txt('other.dusk'), txt('aurora.dusk', '0xwrong'), `${txt()} `, txt().toUpperCase(), `${txt()};extra=yes`])('rejects a mismatching TXT: %s', async value => {
    const store = fixture(), service = createWebsiteVerification(() => store, { fetcher: async () => answer(value) })
    expect((await service.check(node)).status).not.toBe('verified')
  })
  it('distinguishes missing TXT from a mismatch, accepts chunks, and does not require DNSSEC', async () => {
    const store = fixture(), fetcher = vi.fn(async () => answer('', { Answer: [] }))
    const service = createWebsiteVerification(() => store, { fetcher })
    expect((await service.check(node)).status).toBe('unverified')
    fetcher.mockImplementation(async () => answer(txt('other.dusk')))
    expect((await service.check(node)).status).toBe('mismatch')
    fetcher.mockImplementation(async () => answer('', { AD: false, Answer: [{ type: 16, name: '_dusk-domains.harbourline.com.', TTL: 60,
      data: `"dusk-domains-verification=aurora.dusk;" "owner=${owner}"` }] }))
    expect(await service.check(node)).toMatchObject({ status: 'verified', dnssec: false })
  })
  it.each(['owner', 'website', 'path', 'remove', 'release'])('invalidates immediately on %s change', async change => {
    const store = fixture(), fetcher = vi.fn(async () => answer())
    const service = createWebsiteVerification(() => store, { fetcher })
    await service.check(node)
    if (change === 'owner') store.namesByNode.get(node).owner = '0xnew'
    if (change === 'website') store.recordsByNode.get(node)[0].value = 'https://another.com'
    if (change === 'path') store.recordsByNode.get(node)[0].value += '/changed'
    if (change === 'remove') store.recordsByNode.set(node, [])
    if (change === 'release') store.namesByNode.get(node).status = 'released'
    expect(service.read(store, node).status).toBe('unverified')
    await service.tick()
    expect(fetcher.mock.calls.length).toBe(['remove', 'release'].includes(change) ? 1 : 2)
  })
  it('does not publish a lookup that raced an owner change', async () => {
    const store = fixture()
    let finish
    const service = createWebsiteVerification(() => store, { fetcher: () => new Promise(resolve => { finish = resolve }) })
    const checking = service.check(node)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(service.read(store, node).status).toBe('checking')
    store.namesByNode.get(node).owner = '0xnew'
    finish(answer())
    expect((await checking).status).toBe('unverified')
    expect(service.read(store, node).status).toBe('unverified')
  })
  it('verifies subnames with their own owner and website', async () => {
    const store = fixture(), child = `0x${'bb'.repeat(32)}`
    store.subnamesByNode.set(child, { node: child, name: 'pay.aurora.dusk', parentNode: node, owner: 'child-owner', status: 'active', resolver: 'resolver' })
    store.recordsByNode.set(child, [{ key: 'website', value: 'https://harbourline.com' }])
    const service = createWebsiteVerification(() => store, { fetcher: async () => answer(txt('pay.aurora.dusk', 'child-owner')) })
    expect((await service.check(child)).status).toBe('verified')
    store.recordsByNode.delete(child)
    expect(service.read(store, child).status).toBe('unverified')
  })
  it('keeps cached badges until the scheduled recheck completes, including TXT removal', async () => {
    vi.useFakeTimers()
    const store = fixture(), fetcher = vi.fn(async () => answer())
    const service = createWebsiteVerification(() => store, { fetcher })
    await service.tick()
    expect(service.read(store, node).status).toBe('verified')
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000)
    expect(service.read(store, node).status).toBe('verified')
    fetcher.mockImplementation(async () => answer('', { Answer: [] }))
    await service.tick()
    expect(service.read(store, node).status).toBe('unverified')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('falls back to Google on failure and never retains success on resolver errors', async () => {
    const store = fixture(), fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => answer())
    const service = createWebsiteVerification(() => store, { fetcher })
    expect((await service.check(node)).status).toBe('verified')
    expect(String(fetcher.mock.calls[1][0])).toContain('https://dns.google/resolve?')
    fetcher.mockRejectedValue(new Error('offline'))
    expect(await service.check(node)).toMatchObject({ status: 'unverified', dnssec: false })
  })
  it.each([{ Status: 2, AD: true }, { AD: true }, { Status: 0, Answer: 'bad' }])('fails closed on malformed or failed DNS answers %j', async payload => {
    const store = fixture(), fetcher = vi.fn(async () => Response.json(payload))
    const service = createWebsiteVerification(() => store, { fetcher })
    expect((await service.check(node)).status).toBe('unverified')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('bounds slow requests with an abort timeout', async () => {
    const store = fixture(), fetcher = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const service = createWebsiteVerification(() => store, { fetcher, timeoutMs: 10 })
    expect((await service.check(node)).status).toBe('unverified')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('verification API', () => {
  it('adds verification to detail and summary routes without extra DNS lookups', async () => {
    const store = fixture(), fetcher = vi.fn(async () => answer())
    const verification = createWebsiteVerification(() => store, { fetcher })
    const handler = createLocalIndexerHandler(() => store, { verification })
    expect((await request(handler, '/verify?name=AURORA', 'POST')).body).toMatchObject({ canonicalName: 'aurora.dusk', verification: { status: 'verified' } })
    for (const path of [`/name?node=${node}`, '/resolve?name=aurora', '/search?query=aurora']) {
      expect((await request(handler, path)).body.verification.status).toBe('verified')
    }
    expect((await request(handler, '/names')).body.names[0].verification.status).toBe('verified')
    expect((await request(handler, '/resolve?name=aurora')).headers['cache-control']).toBe('no-store')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('enforces one request per canonical name per minute across IPs and five per IP', async () => {
    let time = Date.now()
    const store = fixture(), fetcher = vi.fn(async () => answer())
    const handler = createLocalIndexerHandler(() => store, { now: () => time, verification: createWebsiteVerification(() => store, { fetcher }) })
    expect((await request(handler, '/verify?name=aurora', 'POST')).status).toBe(200)
    expect(await request(handler, '/verify?name=AURORA.DUSK', 'POST', '127.0.0.2')).toMatchObject({ status: 429, headers: { 'retry-after': '60' } })
    for (let i = 0; i < 4; i++) await request(handler, `/verify?name=other${i}`, 'POST')
    expect((await request(handler, '/verify?name=another', 'POST')).status).toBe(429)
    time += 60_000
    expect((await request(handler, '/verify?name=aurora', 'POST')).status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('preserves CORS and the global limiter; validates names and methods', async () => {
    const handler = createLocalIndexerHandler(fixture(), { production: true, corsOrigin: 'https://app.example', rateLimitMax: 20 })
    const headers = { origin: 'https://app.example' }
    expect(await request(handler, '/verify', 'OPTIONS', '127.0.0.1', headers)).toMatchObject({ status: 204, headers: { 'access-control-allow-origin': 'https://app.example', 'access-control-allow-methods': expect.stringContaining('POST') } })
    for (const path of ['/verify', '/verify?name=bad/name', '/verify?name=aurora&name=other']) expect((await request(handler, path, 'POST')).status).toBe(400)
    expect((await request(handler, '/verify?name=aurora')).status).toBe(405)
    expect((await request(handler, '/name', 'POST')).status).toBe(405)
    const limited = createLocalIndexerHandler(fixture(), { rateLimit: true, rateLimitMax: 1 })
    await request(limited, '/verify', 'OPTIONS')
    expect((await request(limited, '/verify?name=aurora', 'POST')).status).toBe(429)
  })
})

it('rechecks a short DNS TTL after five minutes, and stops its timer', async () => {
  vi.useFakeTimers()
  const store = fixture(), fetcher = vi.fn(async () => answer('', { Answer: [{ name: '_dusk-domains.harbourline.com.', type: 16, TTL: 60, data: JSON.stringify(txt()) }] }))
  const service = createWebsiteVerification(() => store, { fetcher })
  service.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(service.read(store, node).status).toBe('verified')
  fetcher.mockImplementation(async () => answer(txt('other.dusk')))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(service.read(store, node).status).toBe('verified')
  expect(fetcher).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(4 * 60_000)
  expect(service.read(store, node).status).toBe('mismatch')
  service.stop()
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('ignores TXT answers for another DNS host and never queries an invalid website', async () => {
  const store = fixture(), fetcher = vi.fn(async () => answer('', { Answer: [{ name: 'another.com.', type: 16, TTL: 60, data: JSON.stringify(txt()) }] }))
  const service = createWebsiteVerification(() => store, { fetcher })
  expect((await service.check(node)).status).toBe('unverified')
  store.recordsByNode.get(node)[0].value = 'https://127.0.0.1'
  expect((await service.check(node)).status).toBe('unverified')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('exposes verification on both marketplace card summaries', async () => {
  const store = fixture(), verification = createWebsiteVerification(() => store, { fetcher: async () => answer() })
  const order = { node, name: 'aurora.dusk', sellerAuthority: owner, marketplaceContractId: `0x${'cc'.repeat(32)}` }
  store.marketplaceFixedSalesByNode = new Map([[node, order]])
  store.marketplaceAuctionsByNode = new Map([[node, order]])
  const handler = createLocalIndexerHandler(store, { verification })
  await verification.check(node)
  expect((await request(handler, '/marketplace/fixed-sales')).body.fixedSales[0].verification.status).toBe('verified')
  expect((await request(handler, '/marketplace/auctions')).body.auctions[0].verification.status).toBe('verified')
})

it('binds checks to the published frozen receipt owner and website', async () => {
  const { createReplayState, applyReplayEvent, finalizeReplayState } = await import('./frozen-view.mjs')
  const { createEventLog, envelope, receipt, recordEffects, rootNode, rootName, bytes, prefixed } = await import('../../scripts/test-fixtures/frozen-events.mjs')
  const state = createReplayState(), warnings = []
  for (const event of [...createEventLog(), envelope(receipt(15, recordEffects('https://harbourline.com')))]) applyReplayEvent(state, event, warnings)
  let store = finalizeReplayState(state, new Date())
  const service = createWebsiteVerification(() => store, { fetcher: async () => answer(txt('aurora.dusk', prefixed(10))) })
  expect((await service.check(rootNode)).status).toBe('verified')
  const name = rootName('https://harbourline.com')
  applyReplayEvent(state, envelope(receipt(16, [[4, 'authorities_changed', { name: { ...name, owner: bytes(14), manager: bytes(14) }, actor: name.owner,
    previous_owner: name.owner, previous_manager: name.manager, data_cleared: false, reason: 'Holder' }]])), warnings)
  store = finalizeReplayState(state, new Date())
  expect(service.read(store, rootNode).status).toBe('unverified')
  expect((await service.check(rootNode)).status).toBe('mismatch')
  applyReplayEvent(state, envelope(receipt(17, recordEffects('https://another.com'))), warnings)
  store = finalizeReplayState(state, new Date())
  expect(service.read(store, rootNode)).toMatchObject({ status: 'unverified', domain: 'another.com' })
})

it('leaves unverified names to Check now instead of re-polling the resolvers', async () => {
  vi.useFakeTimers()
  const store = fixture(), fetcher = vi.fn(async () => Response.json({ Status: 3 }))
  const service = createWebsiteVerification(() => store, { fetcher })
  service.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(service.read(store, node).status).toBe('unverified')
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
  expect(fetcher).toHaveBeenCalledOnce()
  fetcher.mockImplementation(async () => answer())
  expect(await service.check(node)).toMatchObject({ status: 'verified' })
  service.stop()
})

const minute = 60_000
function addName(store, id) {
  const key = `node-${id}`, canonicalName = `name${id}.dusk`
  const name = { ...store.namesByNode.get(node), node: key, canonicalName }
  store.namesByNode.set(key, name)
  store.namesByCanonical.set(canonicalName, name)
  store.recordsByNode.set(key, [{ key: 'website', value: 'https://harbourline.com' }])
  return key
}

it.each([0, 60, 301, 1800, 86400])('rechecks at max(TTL %s, five minutes), capped at six hours, without dropping pending proof', async ttl => {
  vi.useFakeTimers()
  const store = fixture(), fetcher = vi.fn(async () => answer('', { Answer: [
    { name: '_dusk-domains.harbourline.com.', type: 16, TTL: ttl, data: JSON.stringify(txt()) },
  ] }))
  const service = createWebsiteVerification(() => store, { fetcher })
  service.start()
  try {
    await vi.advanceTimersByTimeAsync(0)
    const delay = Math.min(6 * 60, Math.max(5, ttl / 60)) * minute
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(fetcher).toHaveBeenCalledOnce()
    let finish
    fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(service.read(store, node).status).toBe('verified')
    finish(answer('', { Answer: [] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(service.read(store, node).status).toBe('unverified')
    await vi.advanceTimersByTimeAsync(24 * 60 * minute)
    expect(fetcher).toHaveBeenCalledTimes(2)
  } finally { service.stop() }
})

it('backs off resolver errors only while the last good result was verified, and resets after recovery', async () => {
  vi.useFakeTimers()
  const store = fixture(), fetcher = vi.fn(async () => answer())
  const service = createWebsiteVerification(() => store, { fetcher })
  await service.check(node)
  fetcher.mockRejectedValue(new Error('offline'))
  expect((await service.check(node)).status).toBe('unverified')
  for (const minutes of [5, 15, 30, 60, 60]) {
    const calls = fetcher.mock.calls.length
    vi.setSystemTime(Date.now() + minutes * minute - 1)
    await service.tick()
    expect(fetcher).toHaveBeenCalledTimes(calls)
    vi.setSystemTime(Date.now() + 1)
    await service.tick()
    expect(fetcher).toHaveBeenCalledTimes(calls + 2)
    expect(service.read(store, node).status).toBe('unverified')
  }
  fetcher.mockImplementation(async () => answer())
  vi.setSystemTime(Date.now() + 60 * minute)
  await service.tick()
  expect(service.read(store, node).status).toBe('verified')
  fetcher.mockRejectedValue(new Error('offline'))
  await service.check(node)
  const calls = fetcher.mock.calls.length
  vi.setSystemTime(Date.now() + 5 * minute)
  await service.tick()
  expect(fetcher).toHaveBeenCalledTimes(calls + 2)
  fetcher.mockImplementation(async () => answer('', { Answer: [] }))
  vi.setSystemTime(Date.now() + 15 * minute)
  await service.tick()
  const afterRemoval = fetcher.mock.calls.length
  vi.setSystemTime(Date.now() + 24 * 60 * minute)
  await service.tick()
  expect(fetcher).toHaveBeenCalledTimes(afterRemoval)
})

it('does not automatically retry resolver errors for a never-verified binding', async () => {
  vi.useFakeTimers()
  const store = fixture(), fetcher = vi.fn().mockRejectedValue(new Error('offline'))
  const service = createWebsiteVerification(() => store, { fetcher })
  await service.tick()
  expect(service.read(store, node).status).toBe('unverified')
  for (const minutes of [5, 15, 60, 1440]) {
    vi.setSystemTime(Date.now() + minutes * minute)
    await service.tick()
    expect(fetcher).toHaveBeenCalledTimes(2)
  }
  await service.check(node)
  expect(fetcher).toHaveBeenCalledTimes(4)
  store.namesByNode.get(node).owner = 'new-owner'
  await service.tick()
  expect(fetcher).toHaveBeenCalledTimes(6)
  vi.setSystemTime(Date.now() + 1440 * minute)
  await service.tick()
  expect(fetcher).toHaveBeenCalledTimes(6)
})

it('does not carry error retries from a verified binding to a new owner', async () => {
  vi.useFakeTimers()
  const store = fixture(), fetcher = vi.fn(async () => answer())
  const service = createWebsiteVerification(() => store, { fetcher })
  await service.check(node)
  store.namesByNode.get(node).owner = 'new-owner'
  fetcher.mockRejectedValue(new Error('offline'))
  await service.tick()
  vi.setSystemTime(Date.now() + 1440 * minute)
  await service.tick()
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it.each(['verified', 'unverified'])('keeps %s bindings through unrelated market activity', async status => {
  const { createReplayState, applyReplayEvent, finalizeReplayState } = await import('./frozen-view.mjs')
  const { createEventLog, envelope, receipt, recordEffects, rootNode, order, prefixed } = await import('../../scripts/test-fixtures/frozen-events.mjs')
  const state = createReplayState(), warnings = []
  for (const event of [...createEventLog(), envelope(receipt(15, recordEffects('https://harbourline.com')))]) applyReplayEvent(state, event, warnings)
  let store = finalizeReplayState(state, new Date())
  const fetcher = vi.fn(async () => status === 'verified' ? answer(txt('aurora.dusk', prefixed(10))) : answer('', { Answer: [] }))
  const service = createWebsiteVerification(() => store, { fetcher })
  await service.check(rootNode)
  const before = store.recordsByNode.get(rootNode).find(record => record.key === 'website')
  const event = envelope(receipt(16, [[6, 'order_changed', { order: order() }]]))
  event.meta.observedAt = '2026-10-07T13:00:00.000Z'
  applyReplayEvent(state, event, warnings)
  store = finalizeReplayState(state, new Date())
  const after = store.recordsByNode.get(rootNode).find(record => record.key === 'website')
  expect(after.value).toBe(before.value)
  expect(after.updatedAt).not.toBe(before.updatedAt)
  expect(service.read(store, rootNode).status).toBe(status)
  await service.tick()
  expect(fetcher).toHaveBeenCalledOnce()
})

it('evicts oldest non-verified entries before verified ones without automatically repeating negative checks', async () => {
  const store = fixture(), second = addName(store, 2), third = addName(store, 3), fourth = addName(store, 4)
  const fetcher = vi.fn(async () => answer())
  const service = createWebsiteVerification(() => store, { fetcher, maxEntries: 2 })
  await service.check(node)
  await service.check(second)
  await service.check(third)
  expect(service.read(store, node).status).toBe('verified')
  expect(service.read(store, second).status).toBe('retry')
  expect(service.read(store, third).status).toBe('mismatch')
  await service.check(fourth)
  expect(service.read(store, third).status).toBe('retry')
  expect(service.read(store, fourth).status).toBe('mismatch')
  await service.tick()
  expect(fetcher).toHaveBeenCalledTimes(4)
  fetcher.mockImplementation(async () => answer(txt('name2.dusk')))
  expect((await service.check(second)).status).toBe('verified')
  fetcher.mockImplementation(async () => answer(txt('name3.dusk')))
  expect((await service.check(third)).status).toBe('verified')
  expect(service.read(store, node).status).toBe('retry')
  expect(service.read(store, second).status).toBe('verified')
})

it('reports occupied cache capacity distinctly and lets a later manual check reclaim it', async () => {
  const store = fixture(), second = addName(store, 2)
  let finish
  const fetcher = vi.fn(async () => answer()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const service = createWebsiteVerification(() => store, { fetcher, maxEntries: 1 })
  const pending = service.check(node)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  expect((await service.check(second)).status).toBe('retry')
  const handler = createLocalIndexerHandler(() => store, { verification: service })
  expect(await request(handler, '/verify?name=name2', 'POST')).toMatchObject({ status: 503, body: { error: 'verification_busy' } })
  expect(fetcher).toHaveBeenCalledOnce()
  finish(answer())
  await pending
  fetcher.mockImplementation(async () => answer(txt('name2.dusk')))
  expect((await service.check(second)).status).toBe('verified')
})

it('reports lookup concurrency exhaustion as retry rather than missing proof', async () => {
  const store = fixture(), finishes = []
  const fetcher = vi.fn(() => new Promise(resolve => { finishes.push(resolve) }))
  const service = createWebsiteVerification(() => store, { fetcher })
  const pending = Array.from({ length: 8 }, (_, index) => service.check(addName(store, index)))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(8))
  expect((await service.check(node)).status).toBe('retry')
  finishes.forEach(finish => finish(answer()))
  await Promise.all(pending)
})
