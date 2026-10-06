import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createIndexNowWorker, indexNowConfig, sortYielding } from './indexnow.mjs'
import { createLocalIndexerHandler } from './routes.mjs'
import { serveLocalIndexer } from './server.mjs'
import { namesSitemap, namesSitemapEntries } from './share/crawler.mjs'
import { lifecycleClock } from './read-models/lifecycle.mjs'

const key = '0123456789abcdef-ABC'
const origin = 'https://names.example'
const interval = 600_000
const roots = []
const workers = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
  vi.stubEnv('DUSK_DOMAINS_INDEXNOW_KEY', '')
  vi.stubEnv('DUSK_DOMAINS_NOINDEX', 'false')
})

afterEach(async () => {
  for (const worker of workers.splice(0)) worker.stop()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function storeFixture(count = 1) {
  const names = Array.from({ length: count }, (_, i) => ({
    canonicalName: `name${i}.dusk`, node: `node${i}`, status: 'active', expiresAtBlockHeight: 1000,
  }))
  return {
    mode: 'sqlite',
    namesByCanonical: new Map(names.map(name => [name.canonicalName, name])),
    namesByNode: new Map(names.map(name => [name.node, name])),
    subnamesByCanonical: new Map(), subnamesByNode: new Map(),
    activityByNode: new Map([['node0', [{ timestamp: '2026-10-06T11:00:00Z' }]]]),
    checkpoint: { eventCount: 1, lastBlockHeight: 100 },
    cursor: {
      source: 'rusk-finalized-archive', status: 'running', eventCount: 1,
      fromBlock: 1, currentBlockHeight: 100, scannedBlockHeight: 100,
      scannedBlockHash: 'a'.repeat(64), updatedAt: new Date().toISOString(),
    },
  }
}

async function fixture({ count = 1, env = {}, fetchImpl = vi.fn().mockResolvedValue({ status: 200 }) } = {}) {
  const dir = await mkdtemp(resolve('node_modules/.indexnow-test-'))
  roots.push(dir)
  const config = indexNowConfig({ DUSK_DOMAINS_INDEXNOW_KEY: key, DUSK_DOMAINS_SITE_URL: origin, DUSK_DOMAINS_INDEXER_DATA_DIR: dir, ...env })
  const store = storeFixture(count)
  const provider = vi.fn(() => store)
  const logger = { warn: vi.fn() }
  function restart(overrides = {}) {
    const worker = createIndexNowWorker(provider, { config, fetchImpl, logger, ...overrides })
    workers.push(worker)
    return worker
  }
  function advance(ms = interval) {
    vi.setSystemTime(Date.now() + ms)
    store.cursor.updatedAt = new Date().toISOString()
  }
  return {
    config, store, provider, fetchImpl, logger, restart, advance, worker: restart(),
    state: async () => JSON.parse(await readFile(config.stateFile, 'utf8')),
    urls: (call = -1) => JSON.parse(fetchImpl.mock.calls.at(call)[1].body).urlList,
  }
}

it.each(['a'.repeat(8), 'a'.repeat(128), key])('accepts the valid key %s', value => {
  expect(indexNowConfig({ DUSK_DOMAINS_INDEXNOW_KEY: value }).enabled).toBe(true)
})

it.each(['short', 'a'.repeat(129), '1234567_', '1234567/', ' 12345678', '12345678\n', 'é12345678'])('rejects invalid keys at startup: %j', async value => {
  vi.stubEnv('DUSK_DOMAINS_INDEXNOW_KEY', value)
  // Even a disabled instance must reject a malformed configured key.
  vi.stubEnv('DUSK_DOMAINS_NOINDEX', 'true')
  await expect(serveLocalIndexer({ snapshot: 'does-not-exist.json' })).rejects.toThrow('DUSK_DOMAINS_INDEXNOW_KEY')
  expect(() => createLocalIndexerHandler(() => null)).toThrow('DUSK_DOMAINS_INDEXNOW_KEY')
})

it('uses the data directory, state override, endpoint override and canonical origin', () => {
  expect(indexNowConfig({ DUSK_DOMAINS_INDEXER_DATA_DIR: '/data' }).stateFile).toBe('/data/indexnow.json')
  expect(indexNowConfig({}, '/fallback').stateFile).toBe('/fallback/indexnow.json')
  expect(indexNowConfig({
    DUSK_DOMAINS_INDEXNOW_STATE: '/custom/state.json', DUSK_DOMAINS_INDEXNOW_ENDPOINT: 'https://fake.example/indexnow',
    DUSK_DOMAINS_SITE_URL: origin + '/ignored?query=1',
  })).toMatchObject({ stateFile: '/custom/state.json', endpoint: 'https://fake.example/indexnow', origin, host: 'names.example' })
})

it.each([{ DUSK_DOMAINS_INDEXNOW_KEY: '' }, { DUSK_DOMAINS_NOINDEX: 'true' }])('does no background work when disabled: %j', async env => {
  const f = await fixture({ env })
  f.worker.start()
  await f.worker.tick()
  await vi.advanceTimersByTimeAsync(interval * 3)
  expect(f.provider).not.toHaveBeenCalled()
  expect(f.fetchImpl).not.toHaveBeenCalled()
  await expect(readFile(f.config.stateFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

function request(handler, path, method = 'GET') {
  return new Promise(resolveResponse => {
    const response = {
      writeHead: vi.fn(),
      end(body) {
        const [status, headers] = response.writeHead.mock.calls.at(-1)
        resolveResponse({ status, headers, body })
      },
    }
    handler({ url: path, method, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, response)
  })
}

it('serves only the exact key as plain text without loading the read model', async () => {
  vi.stubEnv('DUSK_DOMAINS_INDEXNOW_KEY', key)
  const provider = vi.fn(() => { throw new Error('store unavailable') })
  const handler = createLocalIndexerHandler(provider)
  expect(await request(handler, `/indexnow/${key}.txt`)).toMatchObject({
    status: 200, body: key, headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
  for (const path of ['/indexnow/another-key.txt', `/indexnow/${key}.txt/`, `/indexnow/${key}.json`, '/indexnow/.txt']) {
    expect((await request(handler, path)).status).toBe(404)
  }
  expect((await request(handler, `/indexnow/${key}.txt`, 'POST')).status).toBe(405)
  expect(provider).not.toHaveBeenCalled()
})

it.each([{ DUSK_DOMAINS_INDEXNOW_KEY: '' }, { DUSK_DOMAINS_INDEXNOW_KEY: key, DUSK_DOMAINS_NOINDEX: 'true' }])('returns 404 for the key when disabled: %j', async env => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  expect((await request(createLocalIndexerHandler(() => null), `/indexnow/${key}.txt`)).status).toBe(404)
})

it('submits home, market and active sitemap candidates with a root keyLocation', async () => {
  const f = await fixture({ count: 3 })
  f.store.namesByNode.get('node1').status = 'released'
  f.store.namesByNode.get('node2').expiresAtBlockHeight = 100
  const child = { canonicalName: 'child.name0.dusk', node: 'child', parentNode: 'node0', status: 'active' }
  f.store.subnamesByNode.set(child.node, child)
  f.store.subnamesByCanonical.set(child.canonicalName, child)
  await f.worker.tick()
  expect(f.fetchImpl).toHaveBeenCalledOnce()
  const [endpoint, options] = f.fetchImpl.mock.calls[0]
  expect(endpoint).toBe('https://api.indexnow.org/indexnow')
  expect(options).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, redirect: 'error' })
  expect(JSON.parse(options.body)).toEqual({
    host: 'names.example', key, keyLocation: `${origin}/${key}.txt`,
    urlList: [`${origin}/`, `${origin}/market`, `${origin}/name/child.name0.dusk`, `${origin}/name/name0.dusk`],
  })
  expect((await f.state()).urls).toEqual({
    [`${origin}/`]: null, [`${origin}/market`]: null, [`${origin}/name/name0.dusk`]: '2026-10-06T11:00:00.000Z',
    [`${origin}/name/child.name0.dusk`]: null,
  })
  expect(await readdir(resolve(f.config.stateFile, '..'))).toEqual(['indexnow.json'])
  f.advance()
  await f.worker.tick()
  expect(f.fetchImpl).toHaveBeenCalledOnce()
})

it('submits only new names and changed lastmod values in an incremental read model', async () => {
  const f = await fixture()
  await f.worker.tick()
  f.store.activityByNode.get('node0').push({ timestamp: '2026-10-06T12:01:00Z' })
  const added = { canonicalName: 'added.dusk', node: 'added', status: 'active' }
  f.store.namesByNode.set(added.node, added)
  f.store.namesByCanonical.set(added.canonicalName, added)
  f.store.checkpoint.eventCount = f.store.cursor.eventCount = 2
  f.advance()
  await f.worker.tick()
  expect(f.urls()).toEqual([`${origin}/name/added.dusk`, `${origin}/name/name0.dusk`])
  expect((await f.state()).urls[`${origin}/name/name0.dusk`]).toBe('2026-10-06T12:01:00.000Z')
})

it.each(['release', 'height', 'date', 'absent'])('submits a %s removal once and resubmits a returning name', async kind => {
  const f = await fixture()
  await f.worker.tick()
  const name = f.store.namesByNode.get('node0')
  if (kind === 'release') name.status = 'released'
  if (kind === 'height') name.expiresAtBlockHeight = 100
  if (kind === 'date') {
    delete name.expiresAtBlockHeight
    name.expiresAt = new Date(Date.now() + 1).toISOString()
  }
  if (kind === 'absent') {
    f.store.namesByCanonical.clear()
  }
  f.store.checkpoint.eventCount = f.store.cursor.eventCount = 2
  f.advance()
  await f.worker.tick()
  expect(f.urls()).toEqual([`${origin}/name/name0.dusk`])
  expect((await f.state()).urls[`${origin}/name/name0.dusk`]).toBe('removed')
  f.advance()
  await f.restart().tick()
  expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  name.status = 'active'
  name.expiresAtBlockHeight = 1000
  f.store.namesByCanonical.set(name.canonicalName, name)
  f.store.checkpoint.eventCount = f.store.cursor.eventCount = 3
  f.advance()
  await f.worker.tick()
  expect(f.urls()).toEqual([`${origin}/name/name0.dusk`])
  expect(f.fetchImpl).toHaveBeenCalledTimes(3)
})

it('preserves successful submissions and the ten-minute limit across restart', async () => {
  const f = await fixture()
  await f.worker.tick()
  f.store.activityByNode.get('node0').push({ timestamp: new Date().toISOString() })
  f.store.checkpoint.eventCount = f.store.cursor.eventCount = 2
  f.advance(interval - 1)
  await f.restart().tick()
  expect(f.fetchImpl).toHaveBeenCalledOnce()
  f.advance(1)
  await f.restart().tick()
  expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  f.advance()
  await f.restart().tick()
  expect(f.fetchImpl).toHaveBeenCalledTimes(2)
})

it.each([{ key: 'new-key-123' }, { origin: 'https://other.example', host: 'other.example' }])('starts a new submission history for %j', async change => {
  const f = await fixture()
  await f.worker.tick()
  f.advance()
  await f.restart({ config: { ...f.config, ...change } }).tick()
  expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  expect(f.urls()).toHaveLength(3)
})

it('waits ten minutes between checks and limits each request to 10,000 URLs', async () => {
  const f = await fixture({ count: 10_001 })
  await f.worker.tick()
  expect(f.urls()).toHaveLength(10_000)
  const lifecycles = vi.spyOn(f.store.namesByNode, 'get')
  f.advance(interval - 1)
  await f.worker.tick()
  expect(f.fetchImpl).toHaveBeenCalledOnce()
  f.advance(1)
  await f.worker.tick()
  expect(f.urls()).toHaveLength(3)
  expect(lifecycles).not.toHaveBeenCalled()
  expect(new Set(f.fetchImpl.mock.calls.flatMap(([, options]) => JSON.parse(options.body).urlList)).size).toBe(10_003)
})

it('drains removals and the oldest pending URLs across batches despite continuously updated names', async () => {
  const f = await fixture()
  await f.worker.tick()
  Object.assign(f.store, storeFixture(20_003))
  f.store.namesByNode.get('node0').status = 'released'
  f.store.activityByNode.set('node1', [{ timestamp: '2026-10-06T10:00:00Z' }])
  for (let batch = 0; batch < 3; batch++) {
    f.advance()
    for (let i = 10_003; i < 20_003; i++) {
      f.store.activityByNode.set(`node${i}`, [{ timestamp: new Date().toISOString() }])
    }
    f.store.checkpoint.eventCount = f.store.cursor.eventCount = batch + 2
    await f.worker.tick()
    expect(f.urls()).toHaveLength(10_000)
    if (batch === 0) {
      expect(f.urls()[0]).toBe(`${origin}/name/name0.dusk`)
      expect(f.urls()).not.toContain(`${origin}/name/name1.dusk`)
    }
    if (batch === 1) expect(f.urls()[2]).toBe(`${origin}/name/name1.dusk`)
  }
  const submitted = new Set(f.fetchImpl.mock.calls.slice(1).flatMap(([, options]) => JSON.parse(options.body).urlList))
  expect(submitted).toEqual(new Set([...f.store.namesByCanonical.keys()].map(name => `${origin}/name/${name}`)))
  expect((await f.state()).urls[`${origin}/name/name0.dusk`]).toBe('removed')
})

it.each(['active', 'inactive', 'invalid', 'activity'])('yields at least every 1,000 %s candidates while enumerating', async kind => {
  const f = await fixture({ count: kind === 'activity' ? 1 : 2501 })
  f.store.activityByNode.clear()
  let visited = 0
  const turns = []
  function visit() {
    if (++visited % 1000 === 1) setImmediate(() => turns.push(visited))
  }
  if (kind === 'activity') {
    f.store.activityByNode.set('node0', Array.from({ length: 2501 }, () => ({
      get timestamp() { visit(); return '2026-10-06T11:00:00Z' },
    })))
  } else {
    if (kind === 'inactive') for (const name of f.store.namesByNode.values()) name.status = 'released'
    if (kind === 'invalid') f.store.namesByCanonical = new Map([...f.store.namesByCanonical].map(([name, entry]) => [name.toUpperCase(), entry]))
    const entries = [...f.store.namesByCanonical]
    vi.spyOn(f.store.namesByCanonical, Symbol.iterator).mockImplementation(function* () {
      for (const entry of entries) { visit(); yield entry }
    })
  }
  await f.worker.tick()
  expect(visited).toBe(2501)
  expect(turns).toEqual([1000, 2000, 2501])
  expect(f.logger.warn).not.toHaveBeenCalled()
})

it.each(['date', 'height'])('skips unchanged enumeration but checks %s expiry after an hour', async kind => {
  const f = await fixture()
  const name = f.store.namesByNode.get('node0')
  if (kind === 'date') {
    delete name.expiresAtBlockHeight
    name.expiresAt = new Date(Date.now() + interval).toISOString()
  } else name.expiresAtBlockHeight = 101
  const names = vi.spyOn(f.store.namesByCanonical, Symbol.iterator)
  const activity = vi.spyOn(f.store.activityByNode, Symbol.iterator)
  const lifecycles = vi.spyOn(f.store.namesByNode, 'get')
  await f.worker.tick()
  for (const spy of [names, activity, lifecycles]) spy.mockClear()
  f.store.cursor.currentBlockHeight = f.store.cursor.scannedBlockHeight = 101
  for (let i = 0; i < 5; i++) {
    f.advance()
    await f.worker.tick()
  }
  for (const spy of [names, activity, lifecycles]) expect(spy).not.toHaveBeenCalled()
  expect(f.fetchImpl).toHaveBeenCalledOnce()
  f.advance()
  await f.worker.tick()
  for (const spy of [names, activity, lifecycles]) expect(spy).toHaveBeenCalled()
  expect(f.urls()).toEqual([`${origin}/name/name0.dusk`])
  expect((await f.state()).urls[`${origin}/name/name0.dusk`]).toBe('removed')
})

it('rechecks a replacement read model even with the same event count', async () => {
  const f = await fixture()
  await f.worker.tick()
  f.advance()
  f.provider.mockReturnValue(storeFixture(2))
  await f.worker.tick()
  expect(f.urls()).toEqual([`${origin}/name/name1.dusk`])
})

it('rechecks events applied while candidate enumeration yields', async () => {
  const f = await fixture({ count: 1001 })
  const entries = [...f.store.namesByCanonical]
  let updated = false
  vi.spyOn(f.store.namesByCanonical, Symbol.iterator).mockImplementation(function* () {
    if (!updated) {
      setImmediate(() => {
        f.store.activityByNode.get('node0').push({ timestamp: new Date().toISOString() })
        f.store.checkpoint.eventCount = f.store.cursor.eventCount = 2
        updated = true
      })
    }
    yield* entries
  })
  await f.worker.tick()
  expect(updated).toBe(true)
  expect((await f.state()).urls[`${origin}/name/name0.dusk`]).toBe('2026-10-06T11:00:00.000Z')
  f.advance()
  await f.worker.tick()
  expect(f.urls()).toEqual([`${origin}/name/name0.dusk`])
  expect((await f.state()).urls[`${origin}/name/name0.dusk`]).toBe('2026-10-06T12:00:00.000Z')
})

it('keeps active candidates beyond the XML sitemap limit eligible for submission', () => {
  const store = storeFixture(50_001)
  expect([...namesSitemapEntries(store, lifecycleClock(store), { origin })]).toHaveLength(50_001)
  expect(namesSitemap(store, lifecycleClock(store), { origin }).match(/<loc>/g)).toHaveLength(50_000)
})

it.each([
  ['catching up', store => { store.cursor.status = 'catching_up' }],
  ['lagging', store => { store.cursor.currentBlockHeight += 13 }],
  ['replaying', store => { store.checkpoint.eventCount = 0 }],
  ['stale', store => { store.cursor.updatedAt = new Date(Date.now() - 30_001).toISOString() }],
  ['unverified', store => { store.cursor.source = 'w3sper-live-subscription' }],
  ['warnings', store => { store.warnings = ['incomplete'] }],
  ['degraded', store => { store.health = { ok: false } }],
  ['unknown coverage', store => { delete store.cursor.scannedBlockHash }],
  ['unknown lag', store => { store.mode = 'snapshot'; delete store.cursor }],
])('waits for healthy coverage when %s', async (_, degrade) => {
  const f = await fixture()
  degrade(f.store)
  await f.worker.tick()
  expect(f.fetchImpl).not.toHaveBeenCalled()
  Object.assign(f.store, storeFixture(), { warnings: [], health: { ok: true } })
  f.advance()
  await f.worker.tick()
  expect(f.fetchImpl).toHaveBeenCalledOnce()
})

it.each([200, 202])('records HTTP %i batches', async status => {
  const f = await fixture({ fetchImpl: vi.fn().mockResolvedValue({ status }) })
  await f.worker.tick()
  expect(Object.keys((await f.state()).urls)).toHaveLength(3)
  f.advance()
  await f.restart().tick()
  expect(f.fetchImpl).toHaveBeenCalledOnce()
})

it.each([400, 403, 422, 201, 302])('logs HTTP %i without recording the batch', async status => {
  const f = await fixture({ fetchImpl: vi.fn().mockResolvedValue({ status }) })
  await f.worker.tick()
  expect((await f.state()).urls).toEqual({})
  expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status}`))
  f.advance()
  await f.worker.tick()
  expect(f.fetchImpl).toHaveBeenCalledTimes(2)
})

it.each([429, 500, 503, 599, 'network'])('backs off after %s and persists the delay without recording URLs', async status => {
  const fetchImpl = status === 'network' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue({ status })
  const f = await fixture({ fetchImpl })
  await expect(f.worker.tick()).resolves.toBeUndefined()
  expect((await f.state()).urls).toEqual({})
  expect(f.logger.warn).toHaveBeenCalledOnce()
  f.advance()
  await f.restart().tick()
  expect(fetchImpl).toHaveBeenCalledOnce()
  f.advance()
  await f.worker.tick()
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  f.advance(3 * interval)
  await f.worker.tick()
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  fetchImpl.mockResolvedValue({ status: 202 })
  f.advance()
  await f.worker.tick()
  expect(fetchImpl).toHaveBeenCalledTimes(3)
  expect((await f.state()).failures).toBe(0)
  expect(Object.keys((await f.state()).urls)).toHaveLength(3)
})

it('retains only the accepted batch when a later batch fails', async () => {
  const f = await fixture({ count: 10_001, fetchImpl: vi.fn().mockResolvedValueOnce({ status: 200 }).mockResolvedValue({ status: 503 }) })
  await f.worker.tick()
  f.advance()
  await f.worker.tick()
  expect(Object.keys((await f.state()).urls)).toHaveLength(10_000)
  const failedUrls = f.urls()
  f.advance(2 * interval)
  await f.restart().tick()
  expect(f.urls()).toEqual(failedUrls)
})

it('logs a bad state file without sending or overwriting it', async () => {
  const f = await fixture()
  await writeFile(f.config.stateFile, '{broken')
  await expect(f.worker.tick()).resolves.toBeUndefined()
  expect(f.fetchImpl).not.toHaveBeenCalled()
  expect(f.logger.warn).toHaveBeenCalledOnce()
  expect(await readFile(f.config.stateFile, 'utf8')).toBe('{broken')
})

it('logs persistence and read-model failures without sending', async () => {
  const f = await fixture()
  await mkdir(f.config.stateFile)
  await expect(f.worker.tick()).resolves.toBeUndefined()
  expect(f.fetchImpl).not.toHaveBeenCalled()
  expect(f.logger.warn).toHaveBeenCalledOnce()
  await rm(f.config.stateFile, { recursive: true })
  f.provider.mockRejectedValue(new Error('store unavailable'))
  f.advance()
  await expect(f.worker.tick()).resolves.toBeUndefined()
  expect(f.logger.warn).toHaveBeenCalledTimes(2)
})

it('starts in the background, polls without API requests and stops cleanly', async () => {
  const f = await fixture()
  f.provider.mockImplementation(() => {
    f.store.cursor.updatedAt = new Date().toISOString()
    return f.store
  })
  f.worker.start()
  f.worker.start()
  expect(f.fetchImpl).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  await vi.waitFor(async () => {
    expect(Object.keys((await f.state()).urls)).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(1)
  })
  f.store.namesByNode.get('node0').status = 'released'
  f.store.checkpoint.eventCount = f.store.cursor.eventCount = 2
  await vi.advanceTimersByTimeAsync(interval)
  await vi.waitFor(async () => {
    expect((await f.state()).urls[`${origin}/name/name0.dusk`]).toBe('removed')
    expect(vi.getTimerCount()).toBe(1)
  })
  f.worker.stop()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(interval)
  expect(f.fetchImpl).toHaveBeenCalledTimes(2)
})

it('does not overlap pending submissions or block the HTTP handler, and aborts on stop', async () => {
  let started
  const pending = new Promise(resolveStarted => { started = resolveStarted })
  const fetchImpl = vi.fn((_, { signal }) => new Promise((resolveFetch, reject) => {
    started()
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  const f = await fixture({ fetchImpl })
  const sending = f.worker.tick()
  await pending
  f.advance()
  await f.worker.tick()
  expect(fetchImpl).toHaveBeenCalledOnce()
  const handler = createLocalIndexerHandler(f.provider, { indexNow: f.config })
  expect((await request(handler, '/health')).status).toBe(200)
  expect((await request(handler, `/indexnow/${key}.txt`)).body).toBe(key)
  f.worker.stop()
  await sending
  expect((await f.state()).urls).toEqual({})
})

it('times out a stalled request and retries later', async () => {
  let started
  const pending = new Promise(resolveStarted => { started = resolveStarted })
  const fetchImpl = vi.fn((_, { signal }) => new Promise((resolveFetch, reject) => {
    started()
    signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
  }))
  const f = await fixture({ fetchImpl })
  const sending = f.worker.tick()
  await pending
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true)
  await sending
  expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  expect((await f.state()).urls).toEqual({})
})

it('allows normal finality lag and respects a stricter configured lag limit', async () => {
  const f = await fixture()
  f.store.cursor.currentBlockHeight += 12
  await f.worker.tick()
  expect(f.fetchImpl).toHaveBeenCalledOnce()
  f.advance()
  f.store.namesByNode.get('node0').status = 'released'
  await f.restart({ maxLagBlocks: 1 }).tick()
  expect(f.fetchImpl).toHaveBeenCalledOnce()
  f.store.cursor.currentBlockHeight = 101
  f.advance()
  await f.restart({ maxLagBlocks: 1 }).tick()
  expect(f.fetchImpl).toHaveBeenCalledTimes(2)
})

it('caps repeated throttling backoff at six hours', async () => {
  const f = await fixture({ fetchImpl: vi.fn().mockResolvedValue({ status: 429 }) })
  for (const minutes of [20, 40, 80, 160, 320, 360, 360]) {
    await f.worker.tick()
    const delay = (await f.state()).nextAttemptAt - Date.now()
    expect(delay).toBe(minutes * 60_000)
    f.advance(delay)
  }
})

it('sorts a large backlog in order while letting other work run', async () => {
  const items = Array.from({ length: 25_003 }, (_, index) => [
    `${origin}/name/n${(index * 7919) % 25_003}.dusk`,
    index % 11 === 0 ? null : new Date(Date.UTC(2026, 0, 1) + ((index * 104_729) % 9_973) * 60_000).toISOString(),
  ])
  const compare = ([urlA, a], [urlB, b]) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1) || (urlA < urlB ? -1 : urlA > urlB ? 1 : 0)
  let interleaved = 0
  let ticking = true
  const tick = () => { interleaved += 1; if (ticking) setImmediate(tick) }
  setImmediate(tick)
  const sorted = await sortYielding(items, compare)
  ticking = false
  expect(sorted).toEqual([...items].sort(compare))
  expect(interleaved).toBeGreaterThan(50)
})
