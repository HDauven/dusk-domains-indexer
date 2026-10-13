import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex, parseJson, stringifyJson } from '@duskdomains/sdk'
import { collectArchive } from './archive.mjs'
import { topicsFor } from './frozen.mjs'
import { fetchMarketInitialization } from './deployment.mjs'
import { decodeReceipt, encodeReceipt as encodeReceiptFor } from '../../server/local-indexer/receipt-codec.mjs'
import { loadEventLogStore } from '../../server/local-indexer/event-log-store.mjs'
import { startServer } from '../../server/local-indexer-test-helpers.mjs'
import { binding, bytes, counters, createEventLog, envelope, order, projectionOptions, receipt, rootName } from '../test-fixtures/frozen-events.mjs'
import { deployTransactionHex } from '../test-fixtures/policy-replacement.mjs'
import { feeTx, marketDeployTx, marketDeployment, marketDriver, marketReceipt, marketplaceConfig, preferMarketplace, setMarketplace }
  from '../test-fixtures/market-replacement.mjs'

// A directory fsync that fails once, after the cursor is renamed into place.
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
const rawData = data => Buffer.from(stringifyJson(data)).toString('hex')
const rawEvents = (r, origin) => r.events.map(e => ({ source: e.emitter, topic: e.topic, reverted: false, origin, data: rawData(e.data) }))
const transfer = origin => ({ source: '01' + '00'.repeat(31), topic: 'moonlight', reverted: false, origin, data: '00' })
const foreign = { directory: bytes(9), vault: bytes(2), network: binding.network }

// A fake finalized archive: the launch journal; the replacement market deployed at 15 (paused at
// 250 bps, as marketplace v1 initializes) and, before its admission, set to 300 bps at 16, both
// outside the collected scope; SetMarketplace at 20. `configure: false` keeps the initial fee.
async function harness({ api = 'finalized-block', d = marketDeployment(), configure = true, record = {}, extra = [], outside = [],
  deployArchive, listed = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'market-archive-')); dirs.push(dir)
  await writeFile(join(dir, 'driver.wasm'), '')
  const config = { fromBlock: 1, eventSchemaVersion: '1', chainId: 'dusk:1', nodeUrl: 'http://node.invalid/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: Object.entries(projectionOptions.contracts).map(([contractId, key]) => ({ key, contractId, driverFile: 'driver.wasm', events: topicsFor(key) })) }
  const blocks = new Map(), transactions = new Map()
  const add = (height, events) => blocks.set(height, [...(blocks.get(height) ?? []), ...events])
  for (const [index, entry] of [...createEventLog(), envelope(receipt(20, [setMarketplace(20, d, record)])), ...extra].entries()) {
    const r = decodeReceipt(entry.event.receipt)
    add(Number(r.height), rawEvents(r, hash(10000 + index)))
  }
  add(15, [...rawEvents(marketReceipt(15, d, marketplaceConfig(d.args.binding), marketDeployTx), marketDeployTx), transfer(marketDeployTx)])
  if (configure) add(16, rawEvents(marketReceipt(16, d, marketplaceConfig(d.args.binding, { fee_bps: 300 }), feeTx, 2n), feeTx))
  for (const [height, events] of outside) add(height, events)
  transactions.set(marketDeployTx, { id: marketDeployTx, blockHeight: 15, blockHash: hash(15), err: null, gasSpent: 1,
    tx: { id: marketDeployTx, isDeploy: true, contractId: d.market, raw: deployTransactionHex(d, { archive: deployArchive ?? d.archive }) } })
  transactions.set(feeTx, { id: feeTx, blockHeight: 16, blockHash: hash(16), err: null, gasSpent: 1,
    tx: { id: feeTx, isDeploy: false, contractId: d.market, raw: '00' } })
  let head = 20, failing = null, syncFaultOnEvents = false, clock = Date.parse('2026-10-13T00:00:00.000Z')
  const queries = []
  const listing = events => [...new Set(events.map(e => e.origin))].filter(id => listed || id !== marketDeployTx).map(id => ({ id }))
  async function run({ polls = 1, between } = {}) {
    const controller = new AbortController()
    let observed, waited = 0
    const fetcher = async (_url, { body }) => {
      queries.push(body)
      if (failing && body.includes(failing)) return { ok: true, json: async () => ({ errors: [{ message: `${failing} unavailable` }] }) }
      let result
      if (body.includes('__type')) result = { __type: { fields: [{ name: api === 'event-batch' ? 'contractEventBatch' : 'checkBlock' }] } }
      else if (body.includes('lastBlockPair')) result = { lastBlockPair: { json: { last_block: [head + 2, hash(head + 2)], last_finalized_block: [head, hash(head)] } } }
      else if (body.includes('tx(hash:')) result = { tx: structuredClone(transactions.get(body.match(/hash:"([0-9a-f]+)"/)[1]) ?? null) }
      else if (body.includes('block(height:')) result = { block: { header: header(Number(body.match(/height:(\d+)/)[1])) } }
      else if (body.includes('blocks(range:')) {
        const [, start, end] = body.match(/\[(\d+),(\d+)\]/).map(Number)
        result = { blocks: Array.from({ length: end - start + 1 }, (_, i) => ({ header: header(start + i), transactions: listing(blocks.get(start + i) ?? []) })) }
      } else if (body.includes('checkBlock')) result = Object.fromEntries([...body.matchAll(/(b\d+):checkBlock/g)].map(([, alias]) => [alias, true]))
      else if (body.includes('finalizedEvents(')) result = { finalizedEvents: { json: { events: [], endCursor: null, startCursor: null, hasNextPage: false } } }
      else {
        result = Object.fromEntries([...body.matchAll(/(b\d+):contractEvent(?:Batch|s)\(hash:"([0-9a-f]+)"\)/g)].map(([, alias, blockHash]) =>
          [alias, { blockHash, complete: true, json: blocks.get(parseInt(blockHash, 16)) ?? [] }]))
        if (syncFaultOnEvents) { syncFaultOnEvents = false; directorySyncFault.armed = true }
      }
      return { ok: true, json: async () => result }
    }
    await collectArchive(config, { signal: controller.signal, fetcher, now: () => clock,
      // Archive events here are JSON; the init archive is encoded by the reviewed marketplace driver.
      loadDriver: async () => ({ decodeEvent: (_topic, data) => parseJson(data.toString()), encodeInput: (fn, json) => marketDriver.encodeInput(fn, json) }),
      wait: async () => {
        observed = JSON.parse(await readFile(config.cursorFile))
        if (++waited >= polls) controller.abort()
        else await between?.(waited, observed)
      } })
    return observed
  }
  const rows = async () => (await readFile(config.eventLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const read = async path => {
    const server = await startServer(await loadEventLogStore(config.eventLog, config.cursorFile))
    try { return await (await fetch(server.baseUrl + path)).json() } finally { await server.close() }
  }
  return { config, d, queries, run, rows, read, blocks, transactions, setHead: n => { head = n }, fail: text => { failing = text },
    failDirectorySyncAfterEvents: () => { syncFaultOnEvents = true },
    advance: ms => { clock += ms }, lookups: () => queries.filter(q => q.includes('tx(hash:')).length }
}
const marketConfigOf = (h, market = h.d.market) => h.read(`/marketplace/config?marketplace=0x${market}`)

describe('collecting a replacement marketplace', () => {
  it.each(['finalized-block', 'event-batch'])('journals its configuration before admission right after SetMarketplace, so the API serves it (%s)', async api => {
    const d = marketDeployment(), h = await harness({ api, d, extra: [envelope(receipt(21, [preferMarketplace(21, d)]))] })
    h.setHead(21)
    expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 21,
      marketInitializations: { [d.market]: { status: 'authenticated', transaction: marketDeployTx, blockHeight: 15, configTransaction: feeTx, configBlockHeight: 16 } } })
    const rows = await h.rows(), at = rows.findIndex(row => row.event.initialization), row = rows[at]
    // Directly after the admitting receipt, before the next block's.
    expect([rows[at - 1].meta.blockHeight, row.meta.blockHeight, rows[at + 1].meta.blockHeight]).toEqual([20, 20, 21])
    expect(row.meta).toMatchObject({ blockHash: hash(20), txId: feeTx, eventId: `${hash(16)}:${feeTx}`, eventIndex: 0 })
    expect(row.event.initialization).toEqual({ role: 'marketplace', contractId: d.market, transaction: marketDeployTx, blockHeight: 15,
      blockHash: hash(15), codeHash: d.codeHash, initArchive: hex(d.archive), deployNonce: '8', deploymentOwner: hex(d.owner),
      configTransaction: feeTx, configBlockHeight: 16, configBlockHash: hash(16) })
    expect(decodeReceipt(row.event.receipt).events.map(e => e.topic)).toEqual(['operation_begin', 'market_configured', 'operation_end'])
    // The preferred market's configuration is the one it reached before admission, not a default.
    expect(await h.read('/marketplace/config')).toMatchObject({ initialized: true, marketplaceContractId: `0x${d.market}`, feeBps: 300,
      tradingPaused: true, config: { fee_bps: 300, new_orders_disabled: true } })
    expect((await h.read('/health')).pause).toMatchObject({ tradingPaused: true })
    // A restart neither looks the deployment up again nor duplicates the row.
    const before = h.lookups()
    expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 21, eventCount: rows.length })
    expect(h.lookups()).toBe(before)
    expect(await h.rows()).toEqual(rows)
  })

  it('serves the configuration the deployment initialized when nothing changed it before admission', async () => {
    const h = await harness({ configure: false })
    expect(await h.run()).toMatchObject({ marketInitializations: { [h.d.market]: { status: 'authenticated', configTransaction: marketDeployTx, configBlockHeight: 15 } } })
    expect(await marketConfigOf(h)).toMatchObject({ initialized: true, feeBps: 250, tradingPaused: true })
  })

  it('serves the market\'s own configuration once it emits one after admission', async () => {
    const d = marketDeployment(), opened = marketplaceConfig(d.args.binding, { fee_bps: 300, new_orders_disabled: false })
    const h = await harness({ d, extra: [envelope(marketReceipt(22, d, opened, hash(30022), 3n))] })
    h.setHead(22)
    await h.run()
    expect(await marketConfigOf(h)).toMatchObject({ initialized: true, feeBps: 300, tradingPaused: false })
  })

  it('never journals an unadmitted contract that configures itself as a marketplace', async () => {
    const intruder = marketDeployment({ wasm: 'unadmitted marketplace' })
    const h = await harness({ outside: [[17, rawEvents(marketReceipt(17, intruder, marketplaceConfig(binding, { fee_bps: 900 }), hash(20017)), hash(20017))]] })
    await h.run()
    expect((await h.rows()).filter(row => row.event.initialization).map(row => row.event.initialization.contractId)).toEqual([h.d.market])
    expect(h.queries.some(q => q.includes(hash(20017)))).toBe(false)
    expect(await marketConfigOf(h, intruder.market)).toMatchObject({ initialized: false, feeBps: null })
  })

  const other = marketDeployment({ bind: { ...binding, vault: bytes(99) } })
  it.each([
    ['code_hash_mismatch', { record: { codeHash: hex(bytes(66)) } }],
    ['init_hash_mismatch', { record: { initHash: other.initHash } }],
    // The deployed archive is pinned by the record, but the market initialized with another binding.
    ['initialization_event_mismatch', { record: { initHash: other.initHash }, deployArchive: other.archive }],
    ['binding_mismatch', { d: marketDeployment({ bind: foreign }) }],
    ['pre_admission_activity', { outside: [[17, rawEvents({ events: [
      { emitter: marketDeployment().market, topic: 'operation_begin', data: { op_seq: 3n, height: 17n, call_path: [] } },
      { emitter: marketDeployment().market, topic: 'order_changed', data: { version: 1, op_seq: 3n, body: { order: order('Fixed', 1n) } } },
      { emitter: marketDeployment().market, topic: 'operation_end', data: { op_seq: 3n, call_path: [] } },
    ] }, hash(20017))]] }],
  ])('fails closed on %s without stopping collection, and serves no fee for that market', async (code, options) => {
    const h = await harness(options)
    // A fact about the chain is not asked again in the same run.
    const cursor = await h.run({ polls: 3, between: () => h.advance(24 * 3_600_000) })
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 20 })
    expect(cursor.marketInitializations[h.d.market]).toMatchObject({ status: 'rejected', code, attempts: 1 })
    expect(cursor.marketInitializations[h.d.market].retryAt).toBeUndefined()
    expect((await h.rows()).some(row => row.event.initialization)).toBe(false)
    expect(await marketConfigOf(h)).toMatchObject({ initialized: false, feeBps: null, tradingPaused: true })
    expect((await h.read('/search?query=aurora')).status).toBe('registered')
    expect((await h.read('/health')).cursor.marketInitializations).toEqual({ [h.d.market]: { status: 'rejected', code } })
  })

  it('fails closed when the scan did not see the market\'s deployment, as after upgrading from an older collector', async () => {
    const h = await harness()
    h.setHead(15)
    await h.run()
    // An older collector retained no market configurations.
    const cursor = JSON.parse(await readFile(h.config.cursorFile))
    for (const field of ['marketCandidates', 'marketCandidatesAt', 'marketCandidatesBytes']) delete cursor[field]
    await writeFile(h.config.cursorFile, JSON.stringify(cursor))
    h.setHead(20)
    expect((await h.run()).marketInitializations[h.d.market]).toMatchObject({ status: 'rejected', code: 'initialization_not_collected' })
    expect(await marketConfigOf(h)).toMatchObject({ initialized: false, feeBps: null })
  })

  it('drops retained configurations its cursor no longer vouches for, as after running an older collector', async () => {
    const h = await harness()
    h.setHead(15)
    await h.run()
    const before = JSON.parse(await readFile(h.config.cursorFile))
    h.setHead(19)
    await h.run()
    // An older collector copies the fields it does not know while it scans on, so the cursor
    // keeps the configurations retained at 15 although the fee changed at 16.
    const cursor = JSON.parse(await readFile(h.config.cursorFile))
    await writeFile(h.config.cursorFile, JSON.stringify({ ...cursor, marketCandidates: before.marketCandidates, marketCandidatesAt: before.marketCandidatesAt,
      marketCandidatesBytes: before.marketCandidatesBytes }))
    h.setHead(20)
    expect((await h.run()).marketInitializations[h.d.market]).toMatchObject({ status: 'rejected', code: 'initialization_not_collected' })
    expect(await marketConfigOf(h)).toMatchObject({ initialized: false, feeBps: null })
  })

  it('keeps the configurations a published cursor holds when the directory sync after it fails', async () => {
    const h = await harness()
    h.setHead(15)
    await h.run()
    // Blocks 16 to 19 hold only the fee change, outside the scope: a new configuration, no journal row.
    h.setHead(19)
    h.failDirectorySyncAfterEvents()
    expect(await h.run({ polls: 2 })).toMatchObject({ scannedBlockHeight: 19 })
    h.setHead(20)
    expect((await h.run()).marketInitializations[h.d.market]).toMatchObject({ status: 'authenticated', configBlockHeight: 16 })
    expect(await marketConfigOf(h)).toMatchObject({ initialized: true, feeBps: 300 })
  })

  it('withholds only that market while its deployment lookup fails, and asks again with backoff', async () => {
    const h = await harness()
    h.fail('tx(hash:')
    const cursor = await h.run({ polls: 3, between: async (poll, observed) => {
      const status = observed.marketInitializations[h.d.market]
      if (poll === 1) {
        expect(observed).toMatchObject({ status: 'running', scannedBlockHeight: 20 })
        expect(status).toMatchObject({ status: 'rejected', code: 'lookup_failed', attempts: 1, retryAt: '2026-10-13T00:00:05.000Z' })
        expect(await marketConfigOf(h)).toMatchObject({ initialized: false, feeBps: null })
        h.advance(5_000)
      } else {
        expect(status).toMatchObject({ code: 'lookup_failed', attempts: 2 })
        h.fail(null); h.advance(20_000)
      }
    } })
    expect(cursor.marketInitializations[h.d.market]).toMatchObject({ status: 'authenticated', configBlockHeight: 16 })
    expect(await marketConfigOf(h)).toMatchObject({ initialized: true, feeBps: 300 })
  })

  it.each([
    ['a deployment the node places in another block', h => { h.transactions.get(marketDeployTx).blockHash = 'ab'.repeat(32) }, {}, 'deployment_not_canonical'],
    ['a deployment its block does not list', () => {}, { listed: false, api: 'event-batch' }, 'deployment_not_included'],
    ['a deployment the node does not know', h => { h.transactions.delete(marketDeployTx) }, {}, 'deployment_not_found'],
  ])('rejects %s and asks again later', async (_label, change, options, code) => {
    const h = await harness(options)
    change(h)
    const cursor = await h.run()
    expect(cursor.marketInitializations[h.d.market]).toMatchObject({ status: 'rejected', code, retryAt: expect.any(String) })
    expect(await marketConfigOf(h)).toMatchObject({ initialized: false, feeBps: null })
  })
})

describe('retaining the contracts that configure themselves as marketplaces', () => {
  it('retains every one, so a crowd of them cannot push out a market listed later', async () => {
    // 300 contracts outside the scope configure themselves before the market's deployment at 15.
    const crowd = Array.from({ length: 300 }, (_, i) => {
      const fake = marketDeployment({ wasm: `crowd ${i}` }), origin = hash(50000 + i)
      return rawEvents(marketReceipt(12, fake, marketplaceConfig(binding, { fee_bps: 1 }), origin), origin)
    }).flat()
    const h = await harness({ outside: [[12, crowd]] })
    expect((await h.run()).marketInitializations[h.d.market]).toMatchObject({ status: 'authenticated', configBlockHeight: 16 })
    expect(await marketConfigOf(h)).toMatchObject({ initialized: true, feeBps: 300 })
  })

  it('keeps them in their own file across restarts, without bytes the cursor does not count', async () => {
    const h = await harness()
    h.setHead(17)
    const cursor = await h.run()
    expect(cursor.marketCandidates).toBeUndefined()
    expect(cursor.marketCandidatesBytes).toBeGreaterThan(0)
    expect(cursor.marketCandidatesAt).toEqual({ height: 17, hash: hash(17) })
    // A crash after appending, before the cursor was published.
    await appendFile(h.config.cursorFile.replace(/\.json$/, '.market-candidates.jsonl'), '{"partial":')
    h.setHead(20)
    expect((await h.run()).marketInitializations[h.d.market]).toMatchObject({ status: 'authenticated', configBlockHeight: 16 })
  })

  it.each(['deleted', 'truncated'])('refuses to start when the candidate journal its cursor counts was %s', async damage => {
    const h = await harness()
    h.setHead(17)
    expect((await h.run()).marketCandidatesBytes).toBeGreaterThan(0)
    // As after restoring a cursor without its candidate journal: resetting it would lose markets
    // deployed before the backup and listed after it.
    const file = h.config.cursorFile.replace(/\.json$/, '.market-candidates.jsonl')
    if (damage === 'deleted') await rm(file)
    else await writeFile(file, (await readFile(file)).subarray(0, 5))
    h.setHead(20)
    await expect(h.run()).rejects.toThrow(/Market candidate journal .*cursor\.market-candidates\.jsonl holds \d+ of the \d+ bytes its cursor committed.*restore it/)
  })
})

describe('events of a market that is not authenticated', () => {
  const evil = (d, origin, height) => rawEvents({ events: [
    { emitter: d.market, topic: 'operation_begin', data: { op_seq: 7n, height: BigInt(height), call_path: [[...Buffer.from(d.market, 'hex')]] } },
    { emitter: d.market, topic: 'market_rewritten', data: { version: 1, op_seq: 7n, body: {} } },
    { emitter: d.market, topic: 'operation_end', data: { op_seq: 7n, call_path: [[...Buffer.from(d.market, 'hex')]] } },
  ] }, origin)

  it('are quarantined, all of them, once its authentication failed for good, and collection goes on', async () => {
    const d = marketDeployment()
    // Admitted with a code hash its deployment does not match. Afterwards it emits an event no
    // reviewed driver reads, then a configuration unpaused at 999 bps.
    const opened = marketplaceConfig(d.args.binding, { fee_bps: 999, new_orders_disabled: false })
    const h = await harness({ d, record: { codeHash: hex(bytes(66)) }, outside: [[21, evil(d, hash(30021), 21)],
      [22, rawEvents(marketReceipt(22, d, opened, hash(30022), 8n), hash(30022))]] })
    h.setHead(22)
    const cursor = await h.run()
    const quarantine = { events: 6, code: 'unauthenticated', topic: null, firstBlockHeight: 21, lastBlockHeight: 22, lastTxId: hash(30022) }
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 22,
      marketInitializations: { [d.market]: { status: 'rejected', code: 'code_hash_mismatch' } }, quarantine: { [d.market]: quarantine } })
    expect((await h.rows()).some(row => [hash(30021), hash(30022)].includes(row.meta.txId))).toBe(false)
    expect((await h.read('/health')).collector.quarantine).toEqual({ [`0x${d.market}`]: quarantine })
    expect(await marketConfigOf(h)).toMatchObject({ initialized: false, feeBps: null, tradingPaused: true })
  })

  it('stop collection while the market\'s authentication is pending, and are quarantined once it fails for good', async () => {
    const d = marketDeployment(), h = await harness({ d, record: { codeHash: hex(bytes(66)) }, outside: [[21, evil(d, hash(30021), 21)]] })
    h.setHead(21)
    h.fail('tx(hash:')
    const cursor = await h.run({ polls: 2, between: async (_poll, observed) => {
      // Its lookup failed: it may still be a real market, so nothing of it is dropped yet.
      expect(observed).toMatchObject({ status: 'blocked', scannedBlockHeight: 20,
        blocked: { code: 'unsupported_event', height: 21, emitter: d.market } })
      h.fail(null)
      h.advance(5_000)
    } })
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 21,
      marketInitializations: { [d.market]: { status: 'rejected', code: 'code_hash_mismatch' } },
      quarantine: { [d.market]: { events: 3, code: 'unauthenticated' } } })
  })

  it('still stop collection when the market authenticated', async () => {
    const d = marketDeployment(), h = await harness({ d, outside: [[21, evil(d, hash(30021), 21)]] })
    h.setHead(21)
    expect(await h.run()).toMatchObject({ status: 'blocked', scannedBlockHeight: 20, blocked: { code: 'unsupported_event', height: 21 } })
  })

  it('cannot change what another contract committed in the same transaction', async () => {
    const d = marketDeployment(), origin = hash(30021)
    // In one transaction the directory prefers the market, and the market opens a frame that
    // would abandon the directory's: the directory's action must still count.
    const directoryEvents = rawEvents(decodeReceipt(envelope(receipt(21, [preferMarketplace(21, d)])).event.receipt), origin)
    const path = [[...Buffer.from(d.market, 'hex')]]
    const interleaved = [directoryEvents[0],
      { source: d.market, topic: 'operation_begin', reverted: false, origin, data: rawData({ op_seq: 9n, height: 21n, call_path: path }) },
      ...directoryEvents.slice(1),
      { source: d.market, topic: 'operation_end', reverted: false, origin, data: rawData({ op_seq: 9n, call_path: path }) }]
    // A market whose authentication failed: none of its events count.
    const doomed = await harness({ d, record: { codeHash: hex(bytes(66)) }, outside: [[21, interleaved]] })
    doomed.setHead(21)
    expect((await doomed.run()).quarantine).toMatchObject({ [d.market]: { events: 2, code: 'unauthenticated', lastTxId: origin } })
    expect((await doomed.read('/marketplace/config')).marketplaceContractId).toBe(`0x${d.market}`)
    // A market whose lookup is pending: its frames contradict the directory's, so they are set aside.
    const pending = await harness({ d, outside: [[21, interleaved]] })
    pending.setHead(21)
    pending.fail('tx(hash:')
    expect((await pending.run()).quarantine).toMatchObject({ [d.market]: { events: 2, code: 'interference', lastTxId: origin } })
    expect((await pending.read('/marketplace/config')).marketplaceContractId).toBe(`0x${d.market}`)
  })

  // Frames of a market `d` in transaction `origin`.
  const pathOf = d => [[...Buffer.from(d.market, 'hex')]]
  const begin = (d, origin, opSeq, height) => ({ source: d.market, topic: 'operation_begin', reverted: false, origin,
    data: rawData({ op_seq: opSeq, height: BigInt(height), call_path: pathOf(d) }) })
  const end = (d, origin, opSeq) => ({ source: d.market, topic: 'operation_end', reverted: false, origin, data: rawData({ op_seq: opSeq, call_path: pathOf(d) }) })
  const effect = (d, origin, opSeq, topic, body) => ({ source: d.market, topic, reverted: false, origin, data: rawData({ version: 1, op_seq: opSeq, body }) })
  // A second marketplace, deployed at 14, which `listing` lists in transaction `origin` at 21.
  const second = marketDeployment({ wasm: 'second marketplace', deployNonce: 9n }), secondDeployTx = hash(31014)
  const deploySecond = h => h.transactions.set(secondDeployTx, { id: secondDeployTx, blockHeight: 14, blockHash: hash(14), err: null, gasSpent: 1,
    tx: { id: secondDeployTx, isDeploy: true, contractId: second.market, raw: deployTransactionHex(second) } })
  const secondDeployment = [14, [...rawEvents(marketReceipt(14, second, marketplaceConfig(second.args.binding), secondDeployTx), secondDeployTx), transfer(secondDeployTx)]]
  const listing = origin => rawEvents(decodeReceipt(envelope(receipt(21, [setMarketplace(21, second, { marketVersion: 3n })])).event.receipt), origin)

  it('keep a real market\'s events when another one interferes in the transaction that lists it', async () => {
    // The look-alike was listed at 20 with a code hash its deployment does not match. At 21 one
    // transaction lists the second market and carries its first order after the admission, while
    // the look-alike opens a frame that would abandon the directory's.
    const d = marketDeployment(), origin = hash(30021), [admitBegin, admitted, admitEnd] = listing(origin)
    const h = await harness({ d, record: { codeHash: hex(bytes(66)) }, outside: [secondDeployment, [21, [admitBegin, begin(d, origin, 9n, 21),
      admitted, admitEnd, end(d, origin, 9n), begin(second, origin, 1n, 21),
      effect(second, origin, 1n, 'order_changed', { order: order('Fixed', 1n) }), end(second, origin, 1n)]]] })
    deploySecond(h)
    h.setHead(21)
    const cursor = await h.run()
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 21,
      marketInitializations: { [second.market]: { status: 'authenticated', transaction: secondDeployTx } },
      quarantine: { [d.market]: { events: 2, code: 'unauthenticated' } } })
    expect(cursor.quarantine[second.market]).toBeUndefined()
    expect((await h.read('/marketplace/fixed-sales?marketplace=all')).fixedSales.map(o => [o.marketplaceContractId, o.orderId]))
      .toEqual([[`0x${second.market}`, '1']])
  })

  it('stop collection when a pending market\'s operation encloses a trusted contract\'s', async () => {
    // The market opens an operation and calls the store, whose nested operation closes; then the
    // market's operation reverts without its end frame. The chain committed neither, so setting the
    // market aside would publish a store effect the chain never committed.
    const d = marketDeployment(), origin = hash(30021), store = hex(bytes(4)), path = [...pathOf(d), bytes(4)]
    const h = await harness({ d, outside: [[21, [begin(d, origin, 1n, 21),
      { source: store, topic: 'operation_begin', reverted: false, origin, data: rawData({ op_seq: 2n, height: 21n, call_path: path }) },
      { source: store, topic: 'root_counters_changed', reverted: false, origin,
        data: rawData({ version: 1, op_seq: 2n, body: { root: rootName().key.root, counters } }) },
      { source: store, topic: 'operation_end', reverted: false, origin, data: rawData({ op_seq: 2n, call_path: path }) }]]] })
    h.setHead(21)
    h.fail('tx(hash:')
    expect(await h.run()).toMatchObject({ status: 'blocked', scannedBlockHeight: 20,
      blocked: { code: 'interference', height: 21, emitter: d.market } })
    expect((await h.rows()).some(row => row.meta.txId === origin)).toBe(false)
  })

  it('stop collection when unauthenticated markets\' frames conflict, until their authentication settles', async () => {
    // The first market's lookup is pending; the transaction that lists the second opens the
    // second's frame inside the first's, abandoning it. Neither is proven to be the one at fault.
    const d = marketDeployment(), origin = hash(30021), [admitBegin, admitted, admitEnd] = listing(origin)
    const h = await harness({ d, outside: [secondDeployment, [21, [admitBegin, admitted, admitEnd, begin(d, origin, 1n, 21),
      begin(second, origin, 1n, 21), effect(d, origin, 1n, 'order_changed', { order: order('Fixed', 1n) }), end(d, origin, 1n), end(second, origin, 1n)]]] })
    deploySecond(h)
    h.setHead(21)
    h.fail('tx(hash:')
    const cursor = await h.run({ polls: 2, between: async (_poll, observed) => {
      expect(observed).toMatchObject({ status: 'blocked', scannedBlockHeight: 20, blocked: { code: 'interference', height: 21 } })
      h.fail(null)
      h.advance(5_000)
    } })
    // Both authenticate: the transaction is collected as the chain committed it.
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 21,
      marketInitializations: { [d.market]: { status: 'authenticated' }, [second.market]: { status: 'authenticated' } } })
    expect(cursor.quarantine).toEqual({})
  })
})

describe('authenticating a market configured in the transaction that admits it', () => {
  it('reads only the configurations before the admission', async () => {
    const d = marketDeployment(), admitTx = hash(40000)
    const configured = rawEvents(marketReceipt(15, d, marketplaceConfig(d.args.binding), marketDeployTx), marketDeployTx)
    // In the admitting transaction, before the admission: a fee change. After it: an order.
    const sameTx = [...rawEvents(marketReceipt(20, d, marketplaceConfig(d.args.binding, { fee_bps: 300 }), admitTx, 2n), admitTx),
      { source: hex(bytes(1)), topic: 'action_applied', reverted: false, origin: admitTx, data: '00' },
      ...rawEvents({ events: [
        { emitter: d.market, topic: 'operation_begin', data: { op_seq: 3n, height: 20n, call_path: [] } },
        { emitter: d.market, topic: 'order_changed', data: { version: 1, op_seq: 3n, body: { order: order('Fixed', 1n) } } },
        { emitter: d.market, topic: 'operation_end', data: { op_seq: 3n, call_path: [] } },
      ] }, admitTx)]
    const events = { 15: configured, 20: sameTx }
    const query = async text => {
      if (text.includes('tx(hash:')) return { tx: { id: marketDeployTx, blockHeight: 15, blockHash: hash(15), err: null,
        tx: { id: marketDeployTx, isDeploy: true, contractId: d.market, raw: deployTransactionHex(d) } } }
      const height = Number(text.match(/range:\[(\d+),/)[1])
      return { blocks: [{ header: header(height), transactions: [...new Set(events[height].map(e => e.origin))].map(id => ({ id })) }] }
    }
    const result = await fetchMarketInitialization({ query, blockEvents: async block => events[block.header.height], market: d.market,
      record: { code_hash: [...Buffer.from(d.codeHash, 'hex')], init_hash: [...Buffer.from(d.initHash, 'hex')] },
      candidate: { first: { height: 15, hash: hash(15), txId: marketDeployTx }, last: { height: 20, hash: hash(20), txId: admitTx }, other: false },
      admission: { txId: admitTx, ordinal: 3 }, driver: { decodeEvent: (_topic, data) => parseJson(data.toString()), encodeInput: marketDriver.encodeInput },
      directoryId: hex(bytes(1)), vaultId: hex(bytes(2)) })
    expect(result.rejected).toBeUndefined()
    expect(decodeReceipt(encodeReceiptFor(result.receipt)).events.map(e => e.topic)).toEqual(['operation_begin', 'market_configured', 'operation_end'])
    expect(result.initialization).toMatchObject({ configTransaction: admitTx, configBlockHeight: 20 })
  })
})
