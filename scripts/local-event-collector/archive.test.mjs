import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, vi } from 'vitest'
import { archiveSource, collectArchive, queryArchive } from './archive.mjs'
import { healthResponseForStore } from '../../server/local-indexer/health.mjs'

const directorySyncFault = vi.hoisted(() => ({ armed: false }))
vi.mock('node:fs/promises', async load => {
  const fs = await load()
  return { ...fs, open: async (...args) => {
    const file = await fs.open(...args)
    if (args[1] === 'r' && directorySyncFault.armed) file.sync = async () => {
      directorySyncFault.armed = false
      throw new Error('Injected directory sync failure after cursor rename')
    }
    return file
  } }
})

vi.mock('@dusk/w3sper', () => ({ dataDrivers: { load: async () => ({
  init() {}, decodeEvent: (_topic, bytes) => JSON.parse(Buffer.from(bytes).toString()),
}) } }))

it('replays missed blocks exactly once, preserves event order and rolls back an uncommitted crash tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-collector-'))
  const hash = n => n.toString(16).padStart(64, '0')
  const header = height => ({ height, hash: hash(height), prevBlockHash: hash(height - 1), timestamp: 1_780_000_000 + height })
  const source = hash(900)
  const raw = { source, origin: hash(901), reverted: false, topic: 'record_cleared',
    data: Buffer.from(JSON.stringify({ node: Array(32).fill(1), controller: Array(32).fill(2), key: 'website' })).toString('hex') }
  const events = new Map([[1, [raw, raw]], [3, [{ ...raw, reverted: true }, raw]]])
  const config = { fromBlock: 1, nodeUrl: 'http://node/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: [{ key: 'core', contractId: source, driverFile: 'driver.wasm', events: ['record_cleared'] }] }
  await writeFile(join(dir, 'driver.wasm'), '')
  let head = 2
  let fault = null
  const run = async () => {
    const controller = new AbortController()
    const fetcher = async (_url, { body }) => {
      let result
      if (body.includes('lastBlockPair')) {
        result = { lastBlockPair: { json: { last_block: [head + 1, hash(head + 1)], last_finalized_block: [head, hash(head)] } } }
        const cursor = JSON.parse(await readFile(config.cursorFile))
        if (cursor.scannedBlockHeight === head) controller.abort()
      } else if (body.includes('block(height:')) {
        const height = Number(body.match(/height:(\d+)/)[1])
        result = { block: { header: header(height) } }
        if (fault === 'chain') result.block.header.hash = hash(800)
      } else if (body.includes('blocks(range:')) {
        const [, start, end] = body.match(/\[(\d+),(\d+)\]/).map(Number)
        result = { blocks: Array.from({ length: end - start + 1 }, (_, i) => ({ header: header(start + i) })) }
        if (fault === 'range') { result.blocks.reverse(); controller.abort() }
      } else {
        result = Object.fromEntries([...body.matchAll(/(b\d+):contractEventBatch\(hash:"([0-9a-f]+)"\)/g)].map(([, alias, blockHash]) => {
          const height = parseInt(blockHash, 16)
          if (height === head) controller.abort()
          return [alias, { blockHash, complete: true, json: events.get(height) ?? [] }]
        }))
        if (fault === 'missing') result.b0 = null
        if (fault === 'wrong-hash') result.b0.blockHash = hash(800)
        if (fault === 'decode') result.b0.json = [{ ...raw, data: 'ff' }]
        if (fault === 'rollback') result.b0.json = [{ ...raw, reverted: undefined }]
        if (fault === 'unknown') result.b0.json = [{ ...raw, topic: 'unknown_event' }]
        if (fault === 'directory-sync') directorySyncFault.armed = true
      }
      return { ok: true, json: async () => result }
    }
    await collectArchive(config, { signal: controller.signal, fetcher })
    return JSON.parse(await readFile(config.cursorFile))
  }
  try {
    let cursor = await run()
    assert.equal(cursor.scannedBlockHeight, 2) // A complete empty block advances coverage, not event count.
    assert.equal(cursor.eventCount, 2)
    const first = await readFile(config.eventLog, 'utf8')
    assert.equal((await run()).eventCount, 2)
    assert.equal(await readFile(config.eventLog, 'utf8'), first)
    // The collector is offline while blocks 3..104 are emitted. Partial writes were never committed.
    await appendFile(config.eventLog, '{"uncommitted":')
    head = 104
    cursor = await run()
    assert.equal(cursor.scannedBlockHeight, 104)
    assert.equal(cursor.eventCount, 3)
    let recovered = await readFile(config.eventLog, 'utf8')
    const rows = recovered.trim().split('\n').map(JSON.parse)
    assert.equal(new Set(rows.map(row => row.meta.eventId)).size, 3)
    assert.deepEqual(rows.map(row => [row.meta.blockHeight, row.meta.eventIndex]), [[1, 0], [1, 1], [3, 1]])
    assert(rows.every(row => row.meta.source === archiveSource && row.meta.timeSource === 'block' && row.meta.txId === raw.origin))
    assert.equal(rows[2].meta.observedAt, new Date(header(3).timestamp * 1000).toISOString())
    head = 106
    for (fault of ['missing', 'wrong-hash', 'decode', 'rollback', 'unknown', 'range']) {
      cursor = await run()
      assert.equal(cursor.scannedBlockHeight, 104, fault)
      assert(cursor.reason, fault)
      assert.equal(await readFile(config.eventLog, 'utf8'), recovered, fault)
    }
    fault = null
    assert.equal((await run()).scannedBlockHeight, 106)
    head = 107
    events.set(head, [raw])
    fault = 'directory-sync'
    cursor = await run()
    assert.equal(cursor.eventCount, 4, 'Never erase rows after publishing their cursor, even if directory sync fails')
    recovered = await readFile(config.eventLog, 'utf8')
    assert.equal(recovered.trim().split('\n').length, 4)
    fault = 'chain'
    await assert.rejects(run, /block hash changed/)
    fault = null
    config.contracts[0].contractId = hash(800)
    await assert.rejects(run, /scope changed/)
    config.contracts[0].contractId = source
    await rm(config.cursorFile)
    await assert.rejects(run, /Unbound\/legacy journal/)
    assert.equal(await readFile(config.eventLog, 'utf8'), recovered)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

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
  await assert.rejects(queryArchive('http://node/', '{}', async () => ({ ok: false, status: 503 })), /503/)
  await assert.rejects(queryArchive('http://node/', '{}', async () => ({ ok: true, json: async () => ({ errors: ['unavailable'] }) })), /unavailable/)
})
