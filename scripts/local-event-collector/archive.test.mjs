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
      if (body.includes('__type')) {
        result = { __type: { fields: [{ name: 'contractEvents' }, { name: 'contractEventBatch' }] } }
      } else if (body.includes('lastBlockPair')) {
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
    assert.equal(cursor.archiveApi, 'event-batch')
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

it('reads a released Rusk archive only for blocks it finalized, in transaction order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-collector-'))
  const hash = n => n.toString(16).padStart(64, '0')
  const header = height => ({ height, hash: hash(height), prevBlockHash: hash(height - 1), timestamp: 1_780_000_000 + height })
  const source = hash(900)
  const cleared = (origin, key) => ({ source, origin, reverted: false, topic: 'record_cleared',
    data: Buffer.from(JSON.stringify({ node: Array(32).fill(1), controller: Array(32).fill(2), key })).toString('hex') })
  // Block 2 runs tx b2 before tx a2. Rusk 1.7 returns its finalized events grouped by origin hash.
  const transactions = new Map([[2, [hash(0xb2), hash(0xa2)]], [4, [hash(0xc4)]]])
  const events = new Map([
    [2, [{ ...cleared(hash(2), 'reward'), source: hash(901) }, cleared(hash(0xa2), 'third'), cleared(hash(0xb2), 'first'), cleared(hash(0xb2), 'second')]],
    [4, [cleared(hash(0xd4), 'stray')]],
  ])
  const config = { fromBlock: 1, nodeUrl: 'http://node/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: [{ key: 'core', contractId: source, driverFile: 'driver.wasm', events: ['record_cleared'] }] }
  await writeFile(join(dir, 'driver.wasm'), '')
  let finalized = 3
  let archived = 2
  const run = async () => {
    const controller = new AbortController()
    const fetcher = async (_url, { body }) => {
      const aliases = pattern => [...body.matchAll(pattern)]
      let result
      if (body.includes('__type')) {
        result = { __type: { fields: [{ name: 'contractEvents' }, { name: 'checkBlock' }] } }
      } else if (body.includes('lastBlockPair')) {
        controller.abort() // One poll per run.
        result = { lastBlockPair: { json: { last_block: [finalized + 1, hash(finalized + 1)], last_finalized_block: [finalized, hash(finalized)] } } }
      } else if (body.includes('block(height:')) {
        result = { block: { header: header(Number(body.match(/height:(\d+)/)[1])) } }
      } else if (body.includes('blocks(range:')) {
        assert(body.includes('transactions{id}'))
        const [, start, end] = body.match(/\[(\d+),(\d+)\]/).map(Number)
        result = { blocks: Array.from({ length: end - start + 1 }, (_, i) => ({ header: header(start + i),
          transactions: (transactions.get(start + i) ?? []).map(id => ({ id })) })) }
      } else if (body.includes('checkBlock')) {
        result = Object.fromEntries(aliases(/(b\d+):checkBlock\(height:(\d+),hash:"([0-9a-f]+)",onlyFinalized:true\)/g)
          .map(([, alias, height, blockHash]) => [alias, Number(height) <= archived && blockHash === hash(Number(height))]))
      } else {
        result = Object.fromEntries(aliases(/(b\d+):contractEvents\(hash:"([0-9a-f]+)"\)/g).map(([, alias, blockHash]) => {
          const height = parseInt(blockHash, 16)
          assert(height <= archived, 'Read events of a block the archive has not finalized')
          return [alias, { json: events.get(height) ?? [] }]
        }))
      }
      return { ok: true, json: async () => result }
    }
    await collectArchive(config, { signal: controller.signal, fetcher })
    return JSON.parse(await readFile(config.cursorFile))
  }
  try {
    let cursor = await run()
    assert.equal(cursor.archiveApi, 'finalized-block')
    // Each run ends 'stopped'; the reason is what that poll saw.
    assert.deepEqual([cursor.scannedBlockHeight, cursor.reason], [2, 'Archive has not finalized block 3 yet'])
    const rows = (await readFile(config.eventLog, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(rows.map(row => [row.event.key, row.meta.txId, row.meta.eventIndex]),
      [['first', hash(0xb2), 0], ['second', hash(0xb2), 1], ['third', hash(0xa2), 2]])
    archived = 3
    cursor = await run()
    assert.deepEqual([cursor.scannedBlockHeight, cursor.reason, cursor.eventCount], [3, null, 3])
    finalized = archived = 4
    cursor = await run()
    assert.deepEqual([cursor.scannedBlockHeight, cursor.reason, cursor.eventCount], [3, 'Archive event from unknown origin at 4', 3])
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
  await assert.rejects(queryArchive('http://node/', '{}', async () => ({ ok: false, status: 503 }), { wait: async () => {} }), /503/)
  await assert.rejects(queryArchive('http://node/', '{}', async () => ({ ok: true, json: async () => ({ errors: ['unavailable'] }) })), /unavailable/)
})

it('follows registries the router adds, from the same block on and across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-collector-pool-'))
  const hash = n => n.toString(16).padStart(64, '0')
  const header = height => ({ height, hash: hash(height), prevBlockHash: hash(height - 1), timestamp: 1_780_000_000 + height })
  const [router, firstRegistry, nextRegistry, stranger] = [700, 701, 702, 703].map(hash)
  const encode = value => Buffer.from(JSON.stringify(value)).toString('hex')
  const cleared = source => ({ source, origin: hash(901), reverted: false, topic: 'record_cleared',
    data: encode({ node: Array(32).fill(1), controller: Array(32).fill(2), key: 'website' }) })
  const added = { source: router, origin: hash(902), reverted: false, topic: 'pool_member_added',
    data: encode({ kind: 'Registry', member: [...Buffer.from(nextRegistry, 'hex')], index: 1, operator: { kind: 'Phoenix', bytes: Array(32).fill(3) } }) }
  const events = new Map([[1, [cleared(nextRegistry), added, cleared(nextRegistry), cleared(stranger)]], [2, [cleared(nextRegistry)]]])
  const config = { fromBlock: 1, nodeUrl: 'http://node/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: [
      { key: 'router', contractId: router, driverFile: 'driver.wasm', events: ['pool_member_added'] },
      { key: 'core', contractId: firstRegistry, driverFile: 'driver.wasm', events: ['record_cleared'] },
    ] }
  await writeFile(join(dir, 'driver.wasm'), '')
  const run = async head => {
    const controller = new AbortController()
    const fetcher = async (_url, { body }) => {
      let result
      if (body.includes('__type')) result = { __type: { fields: [{ name: 'contractEventBatch' }] } }
      else if (body.includes('lastBlockPair')) {
        result = { lastBlockPair: { json: { last_block: [head, hash(head)], last_finalized_block: [head, hash(head)] } } }
        if (JSON.parse(await readFile(config.cursorFile)).scannedBlockHeight === head) controller.abort()
      } else if (body.includes('block(height:')) result = { block: { header: header(Number(body.match(/height:(\d+)/)[1])) } }
      else if (body.includes('blocks(range:')) {
        const [, start, end] = body.match(/\[(\d+),(\d+)\]/).map(Number)
        result = { blocks: Array.from({ length: end - start + 1 }, (_, i) => ({ header: header(start + i) })) }
      } else {
        result = Object.fromEntries([...body.matchAll(/(b\d+):contractEventBatch\(hash:"([0-9a-f]+)"\)/g)].map(([, alias, blockHash]) => {
          if (parseInt(blockHash, 16) === head) controller.abort()
          return [alias, { blockHash, complete: true, json: events.get(parseInt(blockHash, 16)) ?? [] }]
        }))
      }
      return { ok: true, json: async () => result }
    }
    await collectArchive(config, { signal: controller.signal, fetcher })
    return (await readFile(config.eventLog, 'utf8')).trim().split('\n').map(JSON.parse)
  }
  try {
    // Before its membership event the registry is not in the pool, so its events are not ours.
    let rows = await run(1)
    assert.deepEqual(rows.map(row => [row.event.type, row.meta.contractKey, row.meta.contractId]), [
      ['pool_member_added', 'router', `0x${router}`],
      ['record_cleared', 'core', `0x${nextRegistry}`],
    ])
    // A restarted collector rebuilds the pool from its journal.
    rows = await run(2)
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.at(-1).meta.contractId, `0x${nextRegistry}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('collects the real driver large-total treasury event, continues with later events and serves exact totals', async () => {
  // Copied from the SDK fixture captured by the protocol's capture-driver-integers.mjs:
  // Rust RKYV -> built Forge driver WASM -> w3sper JSON.parse. The loader mock above
  // returns that captured JSON; no hand-written large-total payload replaces it.
  const fixture = JSON.parse(await readFile(new URL('../test-fixtures/driver-integers.json', import.meta.url), 'utf8'))
  const { loadEventLogStore, createLocalIndexerHandler } = await import('../../server/local-indexer.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'archive-collector-integers-'))
  const hash = n => n.toString(16).padStart(64, '0')
  const header = height => ({ height, hash: hash(height), prevBlockHash: hash(height - 1), timestamp: 1_780_000_000 + height })
  const [treasury, core] = [900, 901].map(hash)
  const raw = (source, topic, value) => ({ source, topic, origin: hash(902), reverted: false,
    data: Buffer.from(JSON.stringify(value)).toString('hex') })
  const events = [
    raw(treasury, fixture.event.topic, fixture.event.decoded),
    raw(core, 'name_registered', { node: Array(32).fill(2), label: 'aurora', actor: Array(32).fill(3), owner: Array(32).fill(3),
      expires_at: '100', grace_ends_at: '200', fee_lux: '10', premium_lux: '0' }),
  ]
  const config = { fromBlock: 1, nodeUrl: 'http://node/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: [
      { key: 'treasury', contractId: treasury, driverFile: 'driver.wasm', events: [fixture.event.topic] },
      { key: 'core', contractId: core, driverFile: 'driver.wasm', events: ['name_registered'] },
    ] }
  const controller = new AbortController()
  const fetcher = async (_url, { body }) => {
    let result
    if (body.includes('__type')) result = { __type: { fields: [{ name: 'contractEventBatch' }] } }
    else if (body.includes('block(height:')) result = { block: { header: header(0) } }
    else if (body.includes('lastBlockPair')) {
      result = { lastBlockPair: { json: { last_block: [2, hash(2)], last_finalized_block: [2, hash(2)] } } }
    } else if (body.includes('blocks(range:')) result = { blocks: [1, 2].map(height => ({ header: header(height) })) }
    else {
      controller.abort() // Finish this batch, even if decoding fails.
      result = Object.fromEntries(events.map((event, i) => [`b${i}`, { blockHash: hash(i + 1), complete: true, json: [event] }]))
    }
    return { ok: true, json: async () => result }
  }
  try {
    await writeFile(join(dir, 'driver.wasm'), '')
    await collectArchive(config, { signal: controller.signal, fetcher })
    const cursor = JSON.parse(await readFile(config.cursorFile, 'utf8'))
    assert.equal(cursor.reason, null)
    assert.equal(cursor.scannedBlockHeight, 2)
    assert.equal(cursor.eventCount, 2)
    const store = await loadEventLogStore(config.eventLog, config.cursorFile)
    assert.deepEqual(store.warnings, [])
    assert.deepEqual(store.events.map(entry => entry.event.type), ['treasury_fee_received', 'name_registered'])
    assert(store.namesByCanonical.has('aurora.dusk'))
    const handler = createLocalIndexerHandler(store)
    const response = await new Promise(resolve => {
      let status
      handler({ url: '/treasury', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, {
        writeHead(code) { status = code }, end(body) { resolve({ status, body: JSON.parse(body) }) },
      })
    })
    assert.equal(response.status, 200)
    assert.deepEqual([response.body.totalReceivedLux, response.body.availableLux, response.body.registrationReceivedLux],
      ['9999995231628421', '9999995231628419', '9999995231628417'])
  } finally { await rm(dir, { recursive: true, force: true }) }
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

it('keeps the cursor and journal unchanged through public archive retries at every query stage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-retry-'))
  const hash = n => n.toString(16).padStart(64, '0')
  const header = height => ({ height, hash: hash(height), prevBlockHash: hash(height - 1), timestamp: 1_780_000_000 + height })
  const source = hash(900)
  const config = { fromBlock: 1, nodeUrl: 'http://node/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: [{ key: 'core', contractId: source, driverFile: 'driver.wasm', events: ['record_cleared'] }] }
  const raw = { source, origin: hash(901), reverted: false, topic: 'record_cleared',
    data: Buffer.from(JSON.stringify({ node: Array(32).fill(1), controller: Array(32).fill(2), key: 'website' })).toString('hex') }
  const attempts = new Map()
  const delays = []
  const controller = new AbortController()
  const fetcher = async (_url, { body }) => {
    const count = (attempts.get(body) ?? 0) + 1
    attempts.set(body, count)
    if (count < 3) return { ok: false, status: count === 1 ? 429 : 503 }
    let result
    if (body.includes('block(height:')) result = { block: { header: header(0) } }
    else if (body.includes('__type')) result = { __type: { fields: [{ name: 'contractEvents' }] } }
    else if (body.includes('lastBlockPair')) result = { lastBlockPair: { json: { last_block: [2, hash(2)], last_finalized_block: [2, hash(2)] } } }
    else if (body.includes('blocks(range:')) {
      assert(body.includes('range:[1,2]'))
      result = { blocks: [1, 2].map(height => ({ header: header(height), transactions: [{ id: raw.origin }] })) }
    } else if (body.includes('checkBlock')) result = { b0: true, b1: true }
    else {
      controller.abort()
      result = { b0: { json: [raw] }, b1: { json: [raw] } }
    }
    return { ok: true, json: async () => result }
  }
  const wait = async ms => {
    if (controller.signal.aborted) return
    delays.push(ms)
    assert.equal(await readFile(config.eventLog, 'utf8'), '')
    try {
      const cursor = JSON.parse(await readFile(config.cursorFile, 'utf8'))
      assert.equal(cursor.scannedBlockHeight, 0)
      assert.equal(cursor.eventCount, 0)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  try {
    await writeFile(join(dir, 'driver.wasm'), '')
    await collectArchive(config, { fetcher, signal: controller.signal, wait })
    const cursor = JSON.parse(await readFile(config.cursorFile, 'utf8'))
    assert.equal(cursor.scannedBlockHeight, 2)
    assert.equal(cursor.eventCount, 2)
    const rows = (await readFile(config.eventLog, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(rows.map(row => row.meta.blockHeight), [1, 2])
    assert.equal(attempts.size, 6)
    assert([...attempts.values()].every(count => count === 3))
    assert.deepEqual(delays, Array.from({ length: 6 }, () => [1000, 2000]).flat())
  } finally { await rm(dir, { recursive: true, force: true }) }
})
