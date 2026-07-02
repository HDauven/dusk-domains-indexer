import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'

import { loadSnapshotStore } from '../server/local-indexer.mjs'
import { parseArgs } from '../server/local-indexer/cli.mjs'
import {
  closeServer,
  expectJson,
  startIndexer as startIndexerFixture,
  writeSnapshot as writeSnapshotFixture,
} from './test-fixtures/local-indexer-server.mjs'

const tempDirs = []
const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeSnapshot(options = {}) {
  return writeSnapshotFixture(options, { trackTempDir: (dir) => tempDirs.push(dir) })
}

async function startIndexer(store, handlerOptions = {}) {
  return startIndexerFixture(store, {
    handlerOptions,
    trackServer: (server) => servers.push(server),
  })
}

describe('local indexer HTTP boundary', () => {
  it('keeps failure semantics stable for local-live clients', async () => {
    const snapshot = await writeSnapshot()
    const store = await loadSnapshotStore(snapshot.file)
    const { baseUrl } = await startIndexer(store)

    const options = await fetch(`${baseUrl}/resolve?name=aurora`, { method: 'OPTIONS' })
    expect(options.status).toBe(204)
    expect(await options.text()).toBe('')

    await expect(expectJson(`${baseUrl}/resolve?name=-bad`, { expectedStatus: 400 })).resolves.toMatchObject({
      verificationStatus: 'unverified',
      errors: [{
        code: 'missing_name',
      }],
    })
    await expect(expectJson(`${baseUrl}/missing`, { expectedStatus: 404 })).resolves.toEqual({
      error: 'not_found',
    })
    await expect(expectJson(`${baseUrl}/resolve?name=aurora`, {
      method: 'POST',
      expectedStatus: 405,
    })).resolves.toEqual({
      error: 'method_not_allowed',
    })
    await expect(expectJson(`${baseUrl}/name`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'missing_node',
      parameter: 'node',
    })
    await expect(expectJson(`${baseUrl}/commitment`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'missing_commitment',
      parameter: 'commitment',
    })
    await expect(expectJson(`${baseUrl}/commitment?commitment=bad`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'invalid_commitment',
      parameter: 'commitment',
    })
    await expect(expectJson(`${baseUrl}/activity?node=not-a-node`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'invalid_node',
      parameter: 'node',
    })
    await expect(expectJson(`${baseUrl}/subnames`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'missing_node',
      parameter: 'parentNode',
    })
    await expect(expectJson(`${baseUrl}/subname`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'missing_node',
      parameter: 'node',
    })
    await expect(expectJson(`${baseUrl}/subname?node=not-a-node`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'invalid_node',
      parameter: 'node',
    })
    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address`, { expectedStatus: 400 })).resolves.toEqual({
      error: 'missing_endpoint',
      message: 'type and value query parameters are required.',
    })
    await expect(expectJson(`${baseUrl}/reverse?type=wallet&value=${snapshot.moonlight}`, { expectedStatus: 400 })).resolves.toEqual({
      error: 'unsupported_endpoint_type',
      type: 'wallet',
      message: 'wallet is not a supported reverse endpoint type.',
    })
  })

  it('uses the configured CORS origin for hosted indexer responses', async () => {
    const snapshot = await writeSnapshot()
    const store = await loadSnapshotStore(snapshot.file)
    const corsOrigin = 'https://dusk.domains'
    const { baseUrl } = await startIndexer(store, { corsOrigin })

    const health = await fetch(`${baseUrl}/health`)
    expect(health.status).toBe(200)
    expect(health.headers.get('access-control-allow-origin')).toBe(corsOrigin)
    await health.json()

    const options = await fetch(`${baseUrl}/resolve?name=aurora`, { method: 'OPTIONS' })
    expect(options.status).toBe(204)
    expect(options.headers.get('access-control-allow-origin')).toBe(corsOrigin)

    const missing = await fetch(`${baseUrl}/missing`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('access-control-allow-origin')).toBe(corsOrigin)
    await expect(missing.json()).resolves.toEqual({ error: 'not_found' })
  })

  it('keeps wildcard CORS by default for local workflows', async () => {
    const snapshot = await writeSnapshot()
    const store = await loadSnapshotStore(snapshot.file)
    const { baseUrl } = await startIndexer(store)

    const health = await fetch(`${baseUrl}/health`)
    expect(health.status).toBe(200)
    expect(health.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('parses hosted CORS origin from env or CLI override', () => {
    expect(parseArgs([], {
      DUSK_DOMAINS_INDEXER_CORS_ORIGIN: 'https://indexer.example',
    })).toMatchObject({
      corsOrigin: 'https://indexer.example',
    })

    expect(parseArgs(['--cors-origin', 'https://dusk.domains'], {
      DUSK_DOMAINS_INDEXER_CORS_ORIGIN: 'https://indexer.example',
    })).toMatchObject({
      corsOrigin: 'https://dusk.domains',
    })
  })

  it('answers protocol-level requests before loading the backing store', async () => {
    let loadAttempts = 0
    const { baseUrl } = await startIndexer(() => {
      loadAttempts += 1
      throw new Error('snapshot unavailable')
    })

    const options = await fetch(`${baseUrl}/resolve?name=aurora`, { method: 'OPTIONS' })
    expect(options.status).toBe(204)
    expect(await options.text()).toBe('')

    await expect(expectJson(`${baseUrl}/resolve?name=aurora`, {
      method: 'POST',
      expectedStatus: 405,
    })).resolves.toEqual({
      error: 'method_not_allowed',
    })
    await expect(expectJson(`${baseUrl}/missing`, { expectedStatus: 404 })).resolves.toEqual({
      error: 'not_found',
    })
    await expect(expectJson(`${baseUrl}/name?node=bad`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'invalid_node',
      parameter: 'node',
    })
    await expect(expectJson(`${baseUrl}/commitment`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'missing_commitment',
      parameter: 'commitment',
    })
    await expect(expectJson(`${baseUrl}/commitment?commitment=bad`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'invalid_commitment',
      parameter: 'commitment',
    })
    await expect(expectJson(`${baseUrl}/subname`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'missing_node',
      parameter: 'node',
    })
    await expect(expectJson(`${baseUrl}/subname?node=bad`, { expectedStatus: 400 })).resolves.toMatchObject({
      error: 'invalid_node',
      parameter: 'node',
    })
    await expect(expectJson(`${baseUrl}/reverse?type=moonlight_address`, { expectedStatus: 400 })).resolves.toEqual({
      error: 'missing_endpoint',
      message: 'type and value query parameters are required.',
    })
    await expect(expectJson(`${baseUrl}/reverse?type=wallet&value=dusk1localresolverproof01`, { expectedStatus: 400 })).resolves.toEqual({
      error: 'unsupported_endpoint_type',
      type: 'wallet',
      message: 'wallet is not a supported reverse endpoint type.',
    })
    expect(loadAttempts).toBe(0)

    await expect(expectJson(`${baseUrl}/health`, { expectedStatus: 500 })).resolves.toMatchObject({
      error: 'local_indexer_error',
      message: 'snapshot unavailable',
    })
    expect(loadAttempts).toBe(1)
  })
})
