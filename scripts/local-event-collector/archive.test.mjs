import assert from 'node:assert/strict'
import { it } from 'vitest'
import { archiveSource, queryArchive } from './archive.mjs'
import { healthResponseForStore } from '../../server/local-indexer/health.mjs'
it('does not call live-only, stale, stopped, lagging or damaged archive state healthy', () => {
  const store = { namesByCanonical: new Map(), checkpoint: { eventCount: 3 },
    cursor: { source: archiveSource, status: 'running', eventCount: 3, updatedAt: new Date().toISOString(),
      fromBlock: 1, currentBlockHeight: 101, scannedBlockHeight: 100, scannedBlockHash: '11'.repeat(32) } }
  assert.equal(healthResponseForStore(store).ok, true)
  for (const change of [
    { status: 'catching-up' }, { status: 'blocked' }, { status: 'stopped' },
    { updatedAt: new Date(Date.now() - 31_000).toISOString() }, { eventCount: 4 },
    { source: 'w3sper-live-subscription' }, { scannedBlockHash: null },
  ]) assert.equal(healthResponseForStore({ ...store, cursor: { ...store.cursor, ...change } }).ok, false)
  assert.equal(healthResponseForStore({ ...store, warnings: [{}] }).ok, false)
  assert.equal(healthResponseForStore({ ...store, mode: 'event-log', cursor: null }).ok, false)
})

it('rejects failed HTTP/GraphQL archive responses instead of interpreting them as empty blocks', async () => {
  await assert.rejects(queryArchive('http://node/', '{}', async () => ({ ok: false, status: 503 }), { wait: async () => {} }), /503/)
  await assert.rejects(queryArchive('http://node/', '{}', async () => ({ ok: true, json: async () => ({ errors: ['unavailable'] }) })), /unavailable/)
})


it('backs off on 429 and 5xx and retries the exact archive query', async () => {
  const delays = []
  const bodies = []
  const statuses = [429, 500, 502, 503, 504, 503, 200]
  const result = await queryArchive('http://node/', '{lastBlockPair{json}}', async (_url, { body }) => {
    bodies.push(body)
    const status = statuses.shift()
    return { ok: status === 200, status, headers: new Headers(status === 429 ? { 'retry-after': '3' } : {}),
      json: async () => ({ data: { result: 'complete' } }) }
  }, { wait: async ms => delays.push(ms) })
  assert.deepEqual(result, { result: 'complete' })
  assert.deepEqual(delays, [3000, 2000, 4000, 8000, 16000, 30000])
  assert.deepEqual(bodies, Array(7).fill('{lastBlockPair{json}}'))
})

it('honours Retry-After dates, bounds retry attempts and cancels backoff', async () => {
  const waits = []
  const date = new Date(Date.now() + 60_000).toUTCString()
  const retry = async () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': date }) })
  await assert.rejects(queryArchive('http://node/', '{}', retry, { wait: async ms => waits.push(ms) }), /503/)
  assert.equal(waits.length, 6)
  assert(waits.every(ms => ms > 58_000 && ms <= 60_000))
  const controller = new AbortController()
  const fetcher = async () => { controller.abort(); return { ok: false, status: 429 } }
  await assert.rejects(queryArchive('http://node/', '{}', fetcher, { signal: controller.signal }), { name: 'AbortError' })
})
