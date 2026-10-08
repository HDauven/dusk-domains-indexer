import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { createWebsiteVerification } from './website-verification.mjs'
import { createIndexNowWorker } from './indexnow.mjs'
import { serveLocalIndexer } from './server.mjs'
import { createStaticLocalIndexerStore } from './stores.mjs'

vi.mock('./website-verification.mjs', () => ({ createWebsiteVerification: vi.fn() }))
vi.mock('node:http', () => ({ createServer: vi.fn() }))
vi.mock('./stores.mjs', () => ({
  createStaticLocalIndexerStore: vi.fn(), createReloadingLocalIndexerStore: vi.fn(),
}))
vi.mock('./indexnow.mjs', async importOriginal => ({
  ...await importOriginal(), createIndexNowWorker: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('starts the worker after listening and stops it when the server closes', async () => {
  vi.stubEnv('DUSK_DOMAINS_INDEXNOW_KEY', 'test-key-123')
  vi.stubEnv('DUSK_DOMAINS_NOINDEX', 'false')
  vi.stubEnv('DUSK_DOMAINS_INDEXER_DATA_DIR', '/configured/data')
  vi.stubEnv('DUSK_DOMAINS_INDEXNOW_STATE', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const verification = { start: vi.fn(), stop: vi.fn() }
  createWebsiteVerification.mockReturnValue(verification)
  const worker = { start: vi.fn(), stop: vi.fn() }
  createIndexNowWorker.mockReturnValue(worker)
  const provider = vi.fn()
  createStaticLocalIndexerStore.mockResolvedValue(provider)
  const server = new EventEmitter()
  server.listen = vi.fn()
  createServer.mockReturnValue(server)
  expect(await serveLocalIndexer({ snapshot: 'target/snapshot.json', port: 5217, host: '127.0.0.1', maxLagBlocks: 4 })).toBe(server)
  expect(createIndexNowWorker).toHaveBeenCalledWith(provider, {
    config: expect.objectContaining({ key: 'test-key-123', enabled: true, stateFile: '/configured/data/indexnow.json' }),
    maxLagBlocks: 4,
  })
  expect(worker.start).not.toHaveBeenCalled()
  expect(verification.start).not.toHaveBeenCalled()
  server.listen.mock.calls[0][2]()
  expect(worker.start).toHaveBeenCalledOnce()
  expect(verification.start).toHaveBeenCalledOnce()
  server.emit('close')
  expect(worker.stop).toHaveBeenCalledOnce()
  expect(verification.stop).toHaveBeenCalledOnce()
})
