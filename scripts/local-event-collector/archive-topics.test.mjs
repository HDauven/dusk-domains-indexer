import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJson, stringifyJson } from '@duskdomains/sdk'
import { collectArchive } from './archive.mjs'
import { topicsFor } from './frozen.mjs'
import { createEventLog, moveHistory, envelope, receipt, admission, bytes, id, projectionOptions } from '../test-fixtures/frozen-events.mjs'
import { decodeReceipt } from '../../server/local-indexer/receipt-codec.mjs'
import { loadEventLogStore } from '../../server/local-indexer/event-log-store.mjs'
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
const dirs = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const hash = n => n.toString(16).padStart(64, '0')
const header = height => ({ height, hash: hash(height), prevBlockHash: hash(height - 1), timestamp: 1791374400 + height })
function rawEntries(entries) {
  const blocks = new Map()
  for (const [index, entry] of entries.entries()) {
    const r = decodeReceipt(entry.event.receipt), height = Number(r.height)
    if (!blocks.has(height)) blocks.set(height, [])
    blocks.get(height).push(...r.events.map(e => ({ source: e.emitter, topic: e.topic, reverted: e.reverted ?? false,
      origin: hash(10000 + index), data: Buffer.from(stringifyJson(e.data)).toString('hex') })))
  }
  return blocks
}
async function harness(api = 'event-batch', entries = createEventLog()) {
  const dir = await mkdtemp(join(tmpdir(), 'frozen-archive-')); dirs.push(dir)
  await writeFile(join(dir, 'driver.wasm'), '')
  const config = { fromBlock: 1, eventSchemaVersion: '1', chainId: 'dusk:1', nodeUrl: 'http://node.invalid/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: Object.entries(projectionOptions.contracts).map(([contractId, key]) => ({ key, contractId, driverFile: 'driver.wasm', events: topicsFor(key) })) }
  const blocks = rawEntries(entries)
  let head = Math.max(...blocks.keys()), fault = null, incomplete = null
  const queries = [], retries = []
  async function run() {
    const controller = new AbortController()
    let observedCursor, retried = false
    const fetcher = async (_url, { body }) => {
      queries.push(body)
      const retryAt = { 'retry-anchor': 'block(height:', 'retry-detect': '__type', 'retry-head': 'lastBlockPair', 'retry-range': 'blocks(range:', 'retry-events': 'contractEvent' }[fault]
      if (retryAt && !retried && body.includes(retryAt)) {
        retried = true
        return { ok: false, status: 503, headers: new Headers() }
      }
      let result
      if (body.includes('__type')) result = { __type: { fields: [{ name: api === 'event-batch' ? 'contractEventBatch' : 'checkBlock' }] } }
      else if (body.includes('lastBlockPair')) result = { lastBlockPair: { json: { last_block: [head + 2, hash(head + 2)], last_finalized_block: [head, hash(head)] } } }
      else if (body.includes('block(height:')) {
        const n = Number(body.match(/height:(\d+)/)[1]); result = { block: { header: header(n) } }
        if (fault === 'anchor') result.block.header.hash = hash(800)
      } else if (body.includes('blocks(range:')) {
        const [, start, end] = body.match(/\[(\d+),(\d+)\]/).map(Number)
        result = { blocks: Array.from({ length: end - start + 1 }, (_, i) => ({ header: header(start + i),
          transactions: [...new Set((blocks.get(start + i) ?? []).map(e => e.origin))].map(id => ({ id })) })) }
        if (fault === 'range') result.blocks.reverse()
      } else if (body.includes('checkBlock')) {
        result = Object.fromEntries([...body.matchAll(/(b\d+):checkBlock\(height:(\d+)/g)].map(([, alias, n]) => [alias, Number(n) !== incomplete]))
      } else {
        result = Object.fromEntries([...body.matchAll(/(b\d+):contractEvent(?:Batch|s)\(hash:"([0-9a-f]+)"\)/g)].map(([, alias, blockHash]) => {
          const height = parseInt(blockHash, 16), json = blocks.get(height) ?? []
          return [alias, { blockHash, complete: incomplete !== height, json }]
        }))
        if (fault === 'missing') result.b0 = null
        if (fault === 'wrong-hash') result.b0.blockHash = hash(800)
        if (fault === 'directory-sync') directorySyncFault.armed = true
      }
      return { ok: true, json: async () => result }
    }
    await collectArchive(config, { signal: controller.signal, fetcher,
      loadDriver: async () => ({ decodeEvent: (_topic, data) => parseJson(data.toString()) }),
      wait: async ms => {
        if (ms === 1000 && fault?.startsWith('retry-')) {
          retries.push({ cursor: JSON.parse(await readFile(config.cursorFile)), journal: await readFile(config.eventLog, 'utf8') }); return
        }
        observedCursor = JSON.parse(await readFile(config.cursorFile)); controller.abort()
      },
    })
    return observedCursor
  }
  return { config, blocks, queries, retries, run, setHead: n => { head = n }, setFault: f => { fault = f }, setIncomplete: n => { incomplete = n },
    rows: async () => (await readFile(config.eventLog, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) }
}
it.each(['event-batch', 'finalized-block'])('replays %s finality, admissions, a full move and restarts without duplicates', async api => {
  const m = moveHistory(), h = await harness(api, [...m.events, m.final])
  h.setHead(20)
  expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 20, eventCount: 7 })
  const first = await h.rows()
  await appendFile(h.config.eventLog, '{"uncommitted":')
  h.setHead(104)
  expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 104, eventCount: 11 })
  expect((await h.rows()).slice(0, 7)).toEqual(first)
  expect(await h.run()).toMatchObject({ eventCount: 11, scannedBlockHeight: 104 })
  const store = await loadEventLogStore(h.config.eventLog, h.config.cursorFile)
  expect(store.warnings).toEqual([])
  expect([...store.namesByNode.values()][0].homeShard).toBe(`0x${id(8)}`)
  expect(store.admissions[id(9)]).toBeDefined()
})
it.each(['missing', 'wrong-hash', 'range'])('does not advance journal/cursor on %s archive failure', async fault => {
  const h = await harness(); h.setHead(10); await h.run()
  const before = await readFile(h.config.eventLog, 'utf8')
  h.setHead(20); h.setFault(fault)
  expect(await h.run()).toMatchObject({ status: 'blocked', scannedBlockHeight: 10, eventCount: 2 })
  expect(await readFile(h.config.eventLog, 'utf8')).toBe(before)
  h.setFault(null); expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 20 })
  h.setFault('anchor'); await expect(h.run()).rejects.toThrow('Committed block hash changed')
})
it.each(['event-batch', 'finalized-block'])('waits for complete archive coverage with %s', async api => {
  const h = await harness(api); h.setIncomplete(11)
  const cursor = await h.run()
  expect(cursor.scannedBlockHeight).toBe(api === 'event-batch' ? 0 : 10)
  expect(cursor.status).toBe(api === 'event-batch' ? 'blocked' : 'catching-up')
  h.setIncomplete(null); expect((await h.run()).scannedBlockHeight).toBe(14)
})
it('filters reverted admissions, admits roles mid-receipt and rejects unknown topics without committing scope', async () => {
  const bad = envelope(receipt(15, [admission('store', 8)])); bad.event.receipt.events[1].reverted = true
  const c = { commitment: { key: { actor: bytes(10), hash: bytes(20) }, created_at: 16n } }
  const good = envelope(receipt(16, [[8, 'commitment_created', c], admission('store', 8), admission('resolver', 9),
    [8, 'commitment_created', { commitment: { ...c.commitment, key: { ...c.commitment.key, hash: bytes(21) } } }]]))
  const h = await harness('event-batch', [...createEventLog(), bad, good]); await h.run()
  const store = await loadEventLogStore(h.config.eventLog, h.config.cursorFile)
  expect(store.warnings).toEqual([])
  expect(store.commitmentsById.has(`0x${id(20)}`)).toBe(false)
  expect(store.commitmentsById.has(`0x${id(21)}`)).toBe(true)
  h.blocks.set(17, [{ source: id(9), origin: hash(900), topic: 'future_topic', data: 'ff', reverted: false }]); h.setHead(17)
  expect(await h.run()).toMatchObject({ status: 'blocked', scannedBlockHeight: 16, reason: expect.stringContaining('Unsupported resolver event') })
  h.blocks.get(17)[0].reverted = true
  expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 17 })
})
it('requires rollback metadata and rejects malformed supported payloads', async () => {
  for (const mode of ['missing-flag', 'bad-data']) {
    const h = await harness(); h.setHead(10); await h.run()
    const raw = h.blocks.get(11)[0]
    if (mode === 'missing-flag') delete raw.reverted
    else raw.data = 'ff'
    h.setHead(11)
    expect(await h.run()).toMatchObject({ status: 'blocked', scannedBlockHeight: 10 })
  }
})

it('retains newly admitted scope and journal rows if directory fsync fails after publishing the cursor', async () => {
  const m = moveHistory(), h = await harness('event-batch', [...m.events, m.final])
  h.setHead(14); await h.run()
  h.setHead(15); h.setFault('directory-sync')
  expect(await h.run()).toMatchObject({ status: 'blocked', scannedBlockHeight: 15, eventCount: 6 })
  expect(await h.rows()).toHaveLength(6)
  h.setFault(null); h.setHead(30)
  expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 30, eventCount: 11 })
  const store = await loadEventLogStore(h.config.eventLog, h.config.cursorFile)
  expect(store.warnings).toEqual([])
  expect([...store.namesByNode.values()][0].homeShard).toBe(`0x${id(8)}`)
})

it.each(['anchor', 'detect', 'head', 'range', 'events'])('keeps the committed journal unchanged while retrying the %s query', async phase => {
  const h = await harness(); h.setHead(10); await h.run()
  const before = await readFile(h.config.eventLog, 'utf8')
  h.setFault(`retry-${phase}`); h.setHead(14)
  expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 14, eventCount: 5 })
  expect(h.retries).toHaveLength(1)
  expect(h.retries[0]).toMatchObject({ cursor: { scannedBlockHeight: 10, eventCount: 2 }, journal: before })
})
