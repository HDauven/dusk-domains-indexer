import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

const { blake2b } = vi.hoisted(() => ({
  blake2b: vi.fn((_input, options = {}) => new Uint8Array(options.dkLen ?? 64)),
}))

vi.mock('@noble/hashes/blake2.js', () => ({ blake2b }))

import { createLocalIndexerHandler } from './local-indexer/routes.mjs'
import { securityOptionsFromEnv } from './local-indexer/security.mjs'
import { indexNamesByAuthority } from './local-indexer/name-authority-index.mjs'

const node = `0x${'11'.repeat(32)}`

function emptyStore() {
  return {
    namesByCanonical: new Map(),
    namesByNode: new Map(),
    subnamesByCanonical: new Map(),
    subnamesByNode: new Map(),
    subnamesByParent: new Map(),
    recordsByNode: new Map(),
    recordsByNodeKey: new Map(),
    activityByNode: new Map(),
    reverseByEndpoint: new Map(),
    marketplaceOffersByKey: new Map(),
  }
}

function request(handler, url, { ip = '127.0.0.1', headers = {} } = {}) {
  return new Promise((resolve) => {
    let status
    handler({ url, method: 'GET', headers, socket: { remoteAddress: ip } }, {
      writeHead(code) { status = code },
      end(body) { resolve({ status, body: body ? JSON.parse(body) : null }) },
    })
  })
}

it.each(['.env.example', 'deploy/systemd/dusk-domains-indexer.service', 'deploy/systemd/dusk-domains-indexer@.service', 'deploy/mainnet.env.example', 'deploy/testnet.env.example'])('keeps forwarded client rate-limit budgets separate with %s', async (file) => {
  const contents = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  const env = Object.fromEntries(contents.split('\n').map((line) => line.replace(/^Environment=/, '')).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split('=')))
  const options = securityOptionsFromEnv(env)
  const handler = createLocalIndexerHandler(emptyStore(), options)

  for (let index = 0; index < options.rateLimitMax; index += 1) {
    const response = await request(handler, '/fee-config', {
      headers: { 'x-forwarded-for': '198.51.100.10' },
    })
    expect(response.status).toBe(200)
  }

  const unrelatedClient = await request(handler, '/fee-config', {
    headers: { 'x-forwarded-for': '203.0.113.20' },
  })
  expect(unrelatedClient.status).toBe(200)
  expect((await request(handler, '/fee-config', {
    headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.10' },
  })).status).toBe(429)
  expect((await request(handler, '/health')).status).toBe(200)
})

it('rejects excessive name depth before hashing', async () => {
  blake2b.mockClear()
  const labels = 1_001
  const name = `${'a.'.repeat(labels - 1)}dusk`
  const response = await request(createLocalIndexerHandler(emptyStore()), `/resolve?name=${name}&limit=1`)

  // The public name policy caps names at 63 characters, which permits fewer than
  // 32 labels and therefore fewer than 64 BLAKE2b calls (two per label).
  expect({ status: response.status, hashCalls: blake2b.mock.calls.length }).toEqual({
    status: 400,
    hashCalls: 0,
  })
})

it('bounds owner-filtered name work to the requested page', async () => {
  let ownerChecks = 0
  const names = Array.from({ length: 1_000 }, (_, index) => {
    const lifecycle = {
      canonicalName: `name${index}.dusk`,
      node: `0x${index.toString(16).padStart(64, '0')}`,
      manager: null,
      status: 'active',
    }
    Object.defineProperty(lifecycle, 'owner', {
      enumerable: true,
      get() {
        ownerChecks += 1
        return node
      },
    })
    return { node: lifecycle.node, lifecycle, records: [] }
  })
  const store = {
    ...emptyStore(),
    namesByCanonical: new Map(names.map((name) => [name.lifecycle.canonicalName, name])),
  }
  store.namesByAuthority = indexNamesByAuthority(store.namesByCanonical, store.controllersByNode)
  ownerChecks = 0

  const response = await request(
    createLocalIndexerHandler(store),
    `/names?owner=0x${'ff'.repeat(32)}&limit=1`,
  )
  expect(response).toMatchObject({ status: 200, body: { names: [], nextCursor: null } })
  expect(ownerChecks).toBeLessThanOrEqual(2)
})

it.each(['0.0.0.0', '::', '192.0.2.1', 'localhost'])('refuses trusted proxy startup on %s without opt-in', async (host) => {
  const { serveLocalIndexer } = await import('./local-indexer/server.mjs')
  const { parseArgs } = await import('./local-indexer/cli.mjs')
  const args = parseArgs(['--host', host, '--snapshot', '.tmp/absent-proxy-snapshot.json'], {
    DUSK_DOMAINS_INDEXER_TRUST_PROXY: 'true',
  })
  await expect(serveLocalIndexer(args)).rejects.toThrow('Trusted proxy requires a loopback listener')
  const allowed = parseArgs(['--host', host, '--snapshot', '.tmp/absent-proxy-snapshot.json'], {
    DUSK_DOMAINS_INDEXER_TRUST_PROXY: 'true', DUSK_DOMAINS_INDEXER_ALLOW_PUBLIC_PROXY_TRUST: 'true',
  })
  await expect(serveLocalIndexer(allowed)).rejects.toThrow('ENOENT')
})

it.each(['127.0.0.1', '127.0.0.2', '::1'])('allows trusted proxy startup on loopback %s', async (host) => {
  const { serveLocalIndexer } = await import('./local-indexer/server.mjs')
  await expect(serveLocalIndexer({ host, trustedProxy: true, snapshot: '.tmp/absent-proxy-snapshot.json' })).rejects.toThrow('ENOENT')
  expect(securityOptionsFromEnv({}).trustedProxy).toBe(false)
  expect(securityOptionsFromEnv({ NODE_ENV: 'production' }).trustedProxy).toBe(false)
})

it.each(['', '-abc', 'abc-', 'abc..def', 'a'.repeat(64), `${'abc.'.repeat(15)}dusk`])('shares search validation and rejects %s before hashing', async (name) => {
  blake2b.mockClear()
  const handler = createLocalIndexerHandler(emptyStore())
  const search = await request(handler, `/search?query=${encodeURIComponent(name)}`)
  const resolved = await request(handler, `/resolve?name=${encodeURIComponent(name)}`)
  expect(search.body.status).toBe('invalid')
  expect(resolved).toMatchObject({ status: 400, body: { node: '0x', errors: [{ code: 'missing_name' }] } })
  expect(blake2b).not.toHaveBeenCalled()
})

it.each(['a'.repeat(58), `${'abc.'.repeat(4)}dusk`, ' Dusk.ABC ', 'abc-def.dusk'])('accepts valid bounded names including %s', async (name) => {
  blake2b.mockClear()
  const handler = createLocalIndexerHandler(emptyStore())
  expect((await request(handler, `/search?query=${encodeURIComponent(name)}`)).body.status).toBe('available')
  const response = await request(handler, `/resolve?name=${encodeURIComponent(name)}`)
  expect(response.status).toBe(200)
  expect(blake2b).toHaveBeenCalledTimes(response.body.canonicalName.split('.').length * 2)
})

it('seeks authority pages without scanning names or controller sets', async () => {
  const manager = `0x${'22'.repeat(32)}`
  const controller = `0x${'33'.repeat(32)}`
  const names = Array.from({ length: 1_000 }, (_, index) => ({
    node: `0x${index.toString(16).padStart(64, '0')}`, records: [],
    lifecycle: { node: `0x${index.toString(16).padStart(64, '0')}`, canonicalName: `name${String(index).padStart(4, '0')}.dusk`, owner: node, manager, status: 'active' },
  }))
  const store = {
    ...emptyStore(),
    namesByCanonical: new Map(names.toReversed().map((name) => [name.lifecycle.canonicalName, name])),
    controllersByNode: new Map(names.map((name) => [name.node, new Set([node, controller])])),
  }
  store.namesByAuthority = indexNamesByAuthority(store.namesByCanonical, store.controllersByNode)
  // A filtered query must use only the prebuilt ordered index, including on later pages.
  store.namesByCanonical.values = () => { throw new Error('scanned names') }
  store.controllersByNode.get = () => { throw new Error('scanned controllers') }
  const handler = createLocalIndexerHandler(store)
  for (const authority of [node, manager, controller.toUpperCase()]) {
    const path = `/names?owner=${authority}&limit=1`
    const first = await request(handler, path)
    expect(first.status).toBe(200)
    expect(first.body.names.map((name) => name.canonicalName)).toEqual(['name0000.dusk'])
    let reads = 0
    const rows = store.namesByAuthority.get(authority.toLowerCase())
    store.namesByAuthority.set(authority.toLowerCase(), new Proxy(rows, {
      get(target, key) {
        if (/^[0-9]+$/.test(String(key))) reads++
        return Reflect.get(target, key)
      },
    }))
    const next = await request(handler, `${path}&cursor=${first.body.nextCursor}`)
    expect(next.status).toBe(200)
    expect(next.body.names.map((name) => name.canonicalName)).toEqual(['name0001.dusk'])
    expect(reads).toBeLessThanOrEqual(12)
  }
})

it('fails explicitly when a supplied store lacks an authority index', async () => {
  const store = emptyStore()
  store.namesByCanonical.values = () => { throw new Error('fallback scan') }
  expect(await request(createLocalIndexerHandler(store), `/names?owner=${node}`)).toMatchObject({
    status: 503, body: { error: 'name_index_unavailable' },
  })
})
