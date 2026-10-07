#!/usr/bin/env node
import { commitJournal } from './test-fixtures/committed-cursor.mjs'
// Measures what one new block costs the API at different journal sizes: the incremental store
// against the full re-import it replaces. Usage: node scripts/indexer-incremental-bench.mjs [sizes...]
// Representative entity populations: add --population [root counts...] (default 1000 5000 10000).
// Concentrated record edits on one name/key: add --concentrated [edit counts...].
import { appendFile, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nameKey, hex } from '@duskdomains/sdk'
import { encodeReceipt } from '../server/local-indexer/receipt-codec.mjs'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { createIncrementalSqliteStore } from '../server/local-indexer/incremental-sqlite-store.mjs'
import { loadSqliteStore } from '../server/local-indexer/sqlite-store.mjs'
import { populationEntries } from './test-fixtures/frozen-population.mjs'
import { createEventLog, envelope, receipt, recordEffects, rootNode } from './test-fixtures/frozen-events.mjs'
import { createReplayState, applyReplayEvent, finalizeReplayState } from '../server/local-indexer/frozen-view.mjs'

const populated = process.argv.includes('--population')
const concentrated = process.argv.includes('--concentrated')
const sizes = process.argv.slice(2).map(Number).filter((size) => size > 0)
const BATCH = 100
const ROUNDS = 5

const bytes = n => Array(32).fill(n)
const directoryId = hex(bytes(1)), storeId = hex(bytes(4))
const projectionOptions = { directoryId, contracts: { [directoryId]: 'directory', [storeId]: 'store' } }
function syntheticEvent(index) {
  const nameIndex = Math.floor(index / 20), blockHeight = 1000 + index, height = BigInt(blockHeight)
  const name = { key: nameKey(`bench${nameIndex}.dusk`), label: `bench${nameIndex}`,
    incarnation: { generation: 1n, serial: 1n }, owner: bytes(10), manager: bytes(11),
    expires_at: 50000000n, grace_end: 50300000n, referrer: null, subname: null, records: null, custody: null }
  const topic = index % 20 === 0 ? 'root_registered' : 'authorities_changed'
  const body = index % 20 === 0
    ? { name, previous_generation: 0n, reason: 'Paid', payer: { kind: 'Contract', bytes: bytes(10) },
      fee_lux: '10000000000', premium_lux: '0', referral_lux: '0', policy: bytes(3), policy_version: 1n, policy_config_version: 1n }
    : { name, previous_owner: bytes(10), previous_manager: bytes(11), actor: bytes(10), reason: 'Holder', data_cleared: false }
  const common = { emitter: storeId, reverted: false }, call_path = [bytes(4)], op_seq = 1n
  const receipt = encodeReceipt({ id: `tx-${index}`, height, success: true, events: [
    { ...common, ordinal: 0, topic: 'operation_begin', data: { height, op_seq, call_path } },
    { ...common, ordinal: 1, topic, data: { version: 1, op_seq, body } },
    { ...common, ordinal: 2, topic: 'operation_end', data: { op_seq, call_path } },
  ] })
  return { event: { type: 'frozen_receipt', receipt, projectionOptions },
    meta: { eventId: receipt.id, txId: receipt.id, blockHeight, contractKey: 'frozen', contractId: directoryId } }
}

function lines(from, count) {
  let text = ''
  for (let index = from; index < from + count; index += 1) text += `${JSON.stringify(syntheticEvent(index))}\n`
  return text
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
function assertReplay(state, count, warnings) {
  assert.deepEqual(warnings, [])
  assert.equal(Object.keys(state.projection.receipts).length, count)
  assert.equal(state.projection.effects.length, count)
  assert.equal(state.newestEventHeight, 999 + count)
}

// Isolate receipt decoding, SDK application and history ingestion from I/O and view building.
// Construct fixtures outside the timed region; no projection snapshots in the receipt loop.
function measureReplay(size) {
  const entries = Array.from({ length: size + BATCH * ROUNDS }, (_, index) => syntheticEvent(index))
  const state = createReplayState(), warnings = [], rounds = []
  for (const entry of entries.slice(0, size)) applyReplayEvent(state, entry, warnings)
  for (let round = 0; round < ROUNDS; round++) {
    const batch = entries.slice(size + round * BATCH, size + (round + 1) * BATCH)
    const started = performance.now()
    for (const entry of batch) applyReplayEvent(state, entry, warnings)
    rounds.push(performance.now() - started)
  }
  assertReplay(state, entries.length, warnings)
  return median(rounds) / BATCH
}

async function measure(size) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-bench-'))
  try {
    const eventLogFile = join(dir, 'events.jsonl')
    const cursorFile = join(dir, 'cursor.json')
    await writeFile(eventLogFile, lines(0, size))
    await commitJournal(eventLogFile, { currentBlockHeight: 1_000 + size, scannedBlockHeight: 1_000 + size }, cursorFile)

    const source = { mode: 'sqlite', file: join(dir, 'incremental.sqlite'), eventLogFile, cursorFile }
    const provider = await createIncrementalSqliteStore(source)
    let next = size
    const incremental = []
    if (provider.indexer.store.warnings.length) throw new Error('Benchmark failed to project its frozen input')
    for (let round = 0; round < ROUNDS; round += 1) {
      await appendFile(eventLogFile, lines(next, BATCH))
      next += BATCH
      await commitJournal(eventLogFile, { scannedBlockHeight: 1000 + next, currentBlockHeight: 1000 + next }, cursorFile)
      const started = performance.now()
      await provider()
      incremental.push(performance.now() - started)
      assertReplay(provider.indexer.replay, next, provider.indexer.store.warnings)
    }
    const heartbeatStarted = performance.now()
    await commitJournal(eventLogFile, { currentBlockHeight: next + 1_001, scannedBlockHeight: next + 1_001 }, cursorFile)
    await provider()
    const heartbeat = performance.now() - heartbeatStarted
    provider.indexer.close()

    // What every heartbeat or new block cost before: re-import the journal and replay it.
    const fullStarted = performance.now()
    const rebuilt = await loadSqliteStore(join(dir, 'full.sqlite'), { eventLogFile, cursorFile })
    const full = performance.now() - fullStarted
    assert.deepEqual(rebuilt.warnings, [])
    assert.equal(rebuilt.checkpoint.eventCount, next)
    assert.equal(rebuilt.namesByNode.size, Math.ceil(next / 20))

    const blockMs = median(incremental)
    return { size, blockMs, perReceiptMs: blockMs / BATCH, heartbeatMs: heartbeat, fullRebuildMs: full }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Complete root receipts, rather than sparse authority-only history. Each root adds a
// primary, two records, an independent referrer and a market order; 10% start moves.
async function measurePopulation(size) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-population-'))
  let provider
  try {
    const eventLogFile = join(dir, 'events.jsonl'), cursorFile = join(dir, 'cursor.json')
    let chunk = '', count = 0
    for (const entry of populationEntries(size)) {
      chunk += `${JSON.stringify(entry)}\n`
      if (++count % 100 === 0) { await appendFile(eventLogFile, chunk); chunk = '' }
    }
    if (chunk) await appendFile(eventLogFile, chunk)
    let next = size, cursorWrites = 0
    const cursor = async height => {
      await commitJournal(eventLogFile, { currentBlockHeight: height, scannedBlockHeight: height }, cursorFile)
      // Ensure each measured heartbeat really reads a new cursor even on coarse filesystems.
      await utimes(cursorFile, new Date(), new Date(Date.now() + ++cursorWrites * 1000))
    }
    await cursor(99 + next)
    provider = await createIncrementalSqliteStore({ mode: 'sqlite', file: join(dir, 'indexer.sqlite'), eventLogFile, cursorFile })
    const validate = () => {
      const store = provider.indexer.store
      assert.deepEqual(store.warnings, [])
      assert.equal(store.namesByNode.size, next + 1)
      assert.equal(store.rawPrimaries.length, next + 1)
      assert.equal(store.reverseByEndpoint.size, next + (store.projectionBlockHeight < 1000 ? 1 : 0))
      assert.equal(store.recordsByNodeKey.size, 2 * next + 1)
      assert.equal(Object.keys(provider.indexer.replay.projection.referrals).length, next)
      assert.equal(store.marketplaceOrders.length, next)
      assert.equal(store.moves.length, Math.ceil(next / 10) + 1)
      assert.equal(store.forwards.length, 1)
      assert.equal(store.checkpoint.eventCount, count)
    }
    validate()
    const publication = [], refresh = [], heartbeat = []
    for (let round = 0; round < ROUNDS; round++) {
      const started = performance.now()
      finalizeReplayState(provider.indexer.replay, new Date().toISOString(), 99 + next)
      publication.push(performance.now() - started)
    }
    for (let round = 0; round < ROUNDS; round++) {
      const batch = [...populationEntries(BATCH, next)]
      await appendFile(eventLogFile, batch.map(e => JSON.stringify(e) + '\n').join(''))
      next += BATCH; count += batch.length
      await cursor(99 + next)
      const started = performance.now()
      await provider()
      refresh.push(performance.now() - started)
      validate()
    }
    let quietHeight = 99 + next
    while (provider.indexer.view.nextLifecycleBoundary != null && provider.indexer.view.nextLifecycleBoundary <= quietHeight + ROUNDS) {
      quietHeight = provider.indexer.view.nextLifecycleBoundary
      await cursor(quietHeight)
      await provider()
    }
    for (let round = 0; round < ROUNDS; round++) {
      await cursor(quietHeight + 1 + round)
      const builds = provider.indexer.stats.viewBuilds
      const started = performance.now()
      await provider()
      heartbeat.push(performance.now() - started)
      assert.equal(provider.indexer.stats.viewBuilds, builds)
      assert.equal(provider.indexer.store.projectionBlockHeight, quietHeight + 1 + round)
      validate()
    }
    // A finalized expiry boundary must publish the whole populated state again.
    await cursor(50000000)
    const started = performance.now()
    await provider()
    const boundaryMs = performance.now() - started
    assert.equal(provider.indexer.store.reverseByEndpoint.size, 0)
    assert.equal(provider.indexer.store.namesByNode.values().next().value.status, 'released')
    assert.equal([...provider.indexer.store.namesByNode.values()].filter(n => n.status === 'grace').length, next)
    return { roots: size + 1, primaries: size + 1, records: size * 2 + 1, referrers: size, orders: size,
      moves: Math.ceil(size / 10) + 1, publicationMs: median(publication), refreshMs: median(refresh),
      heartbeatMs: median(heartbeat), boundaryMs }
  } finally {
    provider?.indexer.close()
    await rm(dir, { recursive: true, force: true })
  }
}


// Thousands of edits share both a name and a record key. This stresses retained
// histories independently of entity count; fixture encoding stays outside timers.
async function measureConcentrated(size) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-concentrated-'))
  let provider
  try {
    const edits = (from, count) => Array.from({ length: count }, (_, i) =>
      envelope(receipt(20 + from + i, recordEffects(`https://edit-${from + i}.example`))))
    const initial = [...createEventLog(), ...edits(0, size)]
    const state = createReplayState(), warnings = [], publication = [], refresh = [], heartbeat = []
    const replayStarted = performance.now()
    for (const entry of initial) applyReplayEvent(state, entry, warnings)
    const replayMs = performance.now() - replayStarted
    assert.deepEqual(warnings, [])
    assert.equal(Object.keys(state.projection.receipts).length, initial.length)
    for (let round = 0; round < ROUNDS; round++) {
      const started = performance.now()
      const view = finalizeReplayState(state, new Date().toISOString(), 19 + size)
      publication.push(performance.now() - started)
      assert.equal(view.recordHistoryByNodeKey.get(`${rootNode}:website`).length, size)
      assert.equal(view.recordHistoryByNodeKey.get(`${rootNode}:website`)[0].value, `https://edit-${size - 1}.example`)
    }
    const eventLogFile = join(dir, 'events.jsonl'), cursorFile = join(dir, 'cursor.json')
    await writeFile(eventLogFile, initial.map(e => JSON.stringify(e) + '\n').join(''))
    let next = size, writes = 0
    const cursor = async height => {
      await commitJournal(eventLogFile, { currentBlockHeight: height, scannedBlockHeight: height }, cursorFile)
      await utimes(cursorFile, new Date(), new Date(Date.now() + ++writes * 1000))
    }
    await cursor(19 + next)
    provider = await createIncrementalSqliteStore({ mode: 'sqlite', file: join(dir, 'indexer.sqlite'), eventLogFile, cursorFile })
    const first = provider.indexer.store, firstHistory = structuredClone(first.recordHistoryByNodeKey.get(`${rootNode}:website`))
    for (let round = 0; round < ROUNDS; round++) {
      await appendFile(eventLogFile, edits(next, BATCH).map(e => JSON.stringify(e) + '\n').join(''))
      next += BATCH
      await cursor(19 + next)
      const started = performance.now()
      const store = await provider()
      refresh.push(performance.now() - started)
      assert.deepEqual(store.warnings, [])
      assert.equal(store.checkpoint.eventCount, 5 + next)
      assert.equal(store.namesByNode.size, 1)
      assert.equal(store.recordsByNode.get(rootNode).length, 2)
      const history = store.recordHistoryByNodeKey.get(`${rootNode}:website`)
      assert.equal(history.length, next)
      assert.equal(history[0].value, `https://edit-${next - 1}.example`)
      assert.equal(history.at(-1).value, 'https://edit-0.example')
      assert.equal(store.activityByNode.get(rootNode).length, first.activityByNode.get(rootNode).length + 2 * (next - size))
    }
    assert.deepEqual(first.recordHistoryByNodeKey.get(`${rootNode}:website`), firstHistory)
    // Settle any lifecycle boundary before measuring quiet heartbeats.
    const quietHeight = Math.max(2001, 19 + next)
    await cursor(quietHeight); await provider()
    for (let round = 0; round < ROUNDS; round++) {
      await cursor(quietHeight + round + 1)
      const builds = provider.indexer.stats.viewBuilds, records = provider.indexer.store.recordsByNode
      const started = performance.now()
      const store = await provider()
      heartbeat.push(performance.now() - started)
      assert.equal(provider.indexer.stats.viewBuilds, builds)
      assert.equal(store.projectionBlockHeight, quietHeight + round + 1)
      assert.equal(store.recordsByNode, records)
    }
    return { edits: size, replayMs, replayPerReceiptMs: replayMs / initial.length,
      publicationMs: median(publication), refreshMs: median(refresh), heartbeatMs: median(heartbeat) }
  } finally {
    provider?.indexer.close()
    await rm(dir, { recursive: true, force: true })
  }
}

if (concentrated) {
  console.log(`Concentrated histories: one root, two records, repeated website edits; medians of ${ROUNDS} publications and ${BATCH}-receipt refreshes`)
  console.log('initial edits | replay ms | replay/receipt ms | publication ms | refresh ms | heartbeat ms')
  for (const size of sizes.length ? sizes : [1000, 5000, 10000]) {
    const row = await measureConcentrated(size)
    console.log(Object.values(row).map(value => Number.isInteger(value) ? value : value.toFixed(3)).join(' | '))
  }
} else if (populated) {
  console.log(`Populated state; medians of ${ROUNDS} publications, ${BATCH}-receipt refreshes and quiet heartbeats`)
  console.log('Initial populations; refresh adds 500 complete roots; boundary heartbeat crosses their expiry')
  console.log('roots | primaries | records | referrers | orders | moves | publication ms | refresh ms | heartbeat ms | boundary ms')
  for (const size of sizes.length ? sizes : [1000, 5000, 10000]) {
    const row = await measurePopulation(size)
    console.log(Object.values(row).map(value => Number.isInteger(value) ? value : value.toFixed(2)).join(' | '))
  }
} else {
  const rows = []
  measureReplay(500) // Warm the receipt path before measuring short histories.
  for (const size of sizes.length ? sizes : [1_000, 5_000]) {
    const replayMs = measureReplay(size)
    rows.push({ ...await measure(size), replayMs })
  }
  console.log(`Batch of ${BATCH} new frozen receipts, median of ${ROUNDS} refreshes`)
  console.log('history  | replay/receipt (ms) | refresh/receipt (ms) | per block (ms) | heartbeat (ms) | full rebuild (ms)')
  for (const row of rows) {
    console.log(`${String(row.size).padEnd(8)} | ${row.replayMs.toFixed(3).padStart(19)} | ${row.perReceiptMs.toFixed(3).padStart(20)} | ${row.blockMs.toFixed(1).padStart(14)} | ${row.heartbeatMs.toFixed(1).padStart(14)} | ${row.fullRebuildMs.toFixed(0).padStart(17)}`)
  }
}
