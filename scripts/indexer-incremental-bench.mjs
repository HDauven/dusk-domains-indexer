#!/usr/bin/env node
// Measures what one new block costs the API at different journal sizes: the incremental store
// against the full re-import it replaces. Usage: node scripts/indexer-incremental-bench.mjs [sizes...]
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createIncrementalSqliteStore } from '../server/local-indexer/incremental-sqlite-store.mjs'
import { loadSqliteStore } from '../server/local-indexer/sqlite-store.mjs'

const sizes = process.argv.slice(2).map(Number).filter((size) => size > 0)
const BATCH = 100
const ROUNDS = 5

function syntheticEvent(index) {
  const nameIndex = Math.floor(index / 20)
  const node = `0x${nameIndex.toString(16).padStart(64, '0')}`
  const blockHeight = 1_000 + index
  if (index % 20 === 0) {
    return {
      event: {
        type: 'name_registered', node, label: `bench${nameIndex}`, actor: '0xowner', owner: '0xowner',
        expiresAt: '2099-01-01T00:00:00.000Z', graceEndsAt: '2099-02-01T00:00:00.000Z',
        expiresAtBlockHeight: 50_000_000, graceEndsAtBlockHeight: 50_300_000,
      },
      meta: { txId: `tx-${index}`, blockHeight, contractKey: 'core', contractId: '0xcore' },
    }
  }
  return {
    event: {
      type: 'record_changed', node, controller: '0xowner',
      record: { key: 'website', value: `https://bench${nameIndex}.example/${index}`, visibility: 'public', updatedAt: '2026-06-17T00:00:00.000Z', ttlSeconds: 300 },
    },
    meta: { txId: `tx-${index}`, blockHeight, contractKey: 'core', contractId: '0xcore' },
  }
}

function lines(from, count) {
  let text = ''
  for (let index = from; index < from + count; index += 1) text += `${JSON.stringify(syntheticEvent(index))}\n`
  return text
}

async function measure(size) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-bench-'))
  try {
    const eventLogFile = join(dir, 'events.jsonl')
    const cursorFile = join(dir, 'cursor.json')
    await writeFile(eventLogFile, lines(0, size))
    await writeFile(cursorFile, JSON.stringify({ version: 1, source: 'rusk-finalized-archive', currentBlockHeight: 1_000 + size, scannedBlockHeight: 1_000 + size }))

    const source = { mode: 'sqlite', file: join(dir, 'incremental.sqlite'), eventLogFile, cursorFile }
    const provider = await createIncrementalSqliteStore(source)
    let next = size
    const incremental = []
    for (let round = 0; round < ROUNDS; round += 1) {
      await appendFile(eventLogFile, lines(next, BATCH))
      next += BATCH
      const started = performance.now()
      await provider()
      incremental.push(performance.now() - started)
    }
    const heartbeatStarted = performance.now()
    await writeFile(cursorFile, JSON.stringify({ version: 1, source: 'rusk-finalized-archive', currentBlockHeight: next + 1_001, scannedBlockHeight: next + 1_001 }))
    await provider()
    const heartbeat = performance.now() - heartbeatStarted
    provider.indexer.close()

    // What every heartbeat or new block cost before: re-import the journal and replay it.
    const fullStarted = performance.now()
    await loadSqliteStore(join(dir, 'full.sqlite'), { eventLogFile, cursorFile })
    const full = performance.now() - fullStarted

    const median = incremental.sort((a, b) => a - b)[Math.floor(ROUNDS / 2)]
    return { size, blockMs: median, perEventMs: median / BATCH, heartbeatMs: heartbeat, fullRebuildMs: full }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const rows = []
for (const size of sizes.length ? sizes : [10_000, 100_000]) rows.push(await measure(size))
console.log(`Batch of ${BATCH} new events, median of ${ROUNDS} refreshes`)
console.log('events   | per block (ms) | per event (ms) | heartbeat (ms) | full rebuild (ms)')
for (const row of rows) {
  console.log(`${String(row.size).padEnd(8)} | ${row.blockMs.toFixed(1).padStart(14)} | ${row.perEventMs.toFixed(3).padStart(14)} | ${row.heartbeatMs.toFixed(1).padStart(14)} | ${row.fullRebuildMs.toFixed(0).padStart(17)}`)
}
