import { createEventLog, rootNode, envelope, receipt, recordEffects } from '../scripts/test-fixtures/frozen-events.mjs'
import { appendFile, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createIncrementalSqliteStore } from './local-indexer/incremental-sqlite-store.mjs'
import { loadSqliteStore } from './local-indexer/sqlite-store.mjs'
import { createReloadingLocalIndexerStore } from './local-indexer/stores.mjs'
import { commitJournal } from '../scripts/test-fixtures/committed-cursor.mjs'
import { healthResponseForStore } from './local-indexer/health.mjs'
import { resolveForward } from './local-indexer/read-models/forward.mjs'
import { listNames, recordHistoryForNode } from './local-indexer/read-models.mjs'

const dirs = []
const providers = []

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.indexer.close()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(events) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-incremental-'))
  dirs.push(dir)
  const eventLogFile = join(dir, 'events.jsonl')
  const cursorFile = join(dir, 'cursor.json')
  await writeFile(eventLogFile, lines(events), 'utf8')
  await commitJournal(eventLogFile, { currentBlockHeight: 20, scannedBlockHeight: 20, eventCount: events.length }, cursorFile)
  const source = { mode: 'sqlite', file: join(dir, 'indexer.sqlite'), eventLogFile, cursorFile }
  return { dir, eventLogFile, cursorFile, source }
}

async function open(source) {
  const provider = await createIncrementalSqliteStore(source)
  providers.push(provider)
  return provider
}

function lines(events) {
  return events.map((entry) => `${JSON.stringify(entry)}\n`).join('')
}

function recordEvent(value, blockHeight) {
  return envelope(receipt(blockHeight, recordEffects(value)))
}

function websiteOf(store) {
  return store.recordsByNode.get(rootNode)?.find((record) => record.key === 'website')?.value ?? null
}

describe('incremental SQLite store', () => {
  it('applies appended journal lines without replaying the journal', async () => {
    const { eventLogFile, source } = await setup(createEventLog())
    const provider = await open(source)
    const { indexer } = provider
    expect(indexer.stats).toMatchObject({ rebuilds: 1, appliedEvents: 5 })

    await appendFile(eventLogFile, lines([recordEvent('https://one.example', 15)]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 20, currentBlockHeight: 20 })
    const store = await provider()

    expect(websiteOf(store)).toBe('https://one.example')
    expect(indexer.stats).toMatchObject({ rebuilds: 1, appliedEvents: 6 })
    expect(store.checkpoint).toMatchObject({ eventCount: 6, lastBlockHeight: 15 })
  })

  it('preserves earlier cached stores and response DTOs across receipts and lifecycle heartbeats', async () => {
    const { eventLogFile, cursorFile, source } = await setup([...createEventLog(), recordEvent('https://first.example', 15)])
    const provider = await open(source)
    const first = await provider(), snapshot = structuredClone(first)
    const response = { names: listNames(first), history: recordHistoryForNode(first, rootNode) }
    const responseSnapshot = structuredClone(response)
    await appendFile(eventLogFile, lines([recordEvent('https://second.example', 16)]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 20, currentBlockHeight: 20 })
    const second = await provider(), secondSnapshot = structuredClone(second)
    expect(websiteOf(second)).toBe('https://second.example')
    expect(first).toEqual(snapshot)
    expect(response).toEqual(responseSnapshot)
    expect(second.activityByNode.get(rootNode).length).toBe(first.activityByNode.get(rootNode).length + 2)
    await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: 1001, scannedBlockHeight: 1000 }, cursorFile)
    expect((await provider()).namesByNode.get(rootNode).status).toBe('grace')
    expect(first).toEqual(snapshot)
    expect(second).toEqual(secondSnapshot)
    expect(response).toEqual(responseSnapshot)
  })

  it('does no replay work for a cursor heartbeat or an unchanged journal', async () => {
    const { cursorFile, source } = await setup(createEventLog())
    const provider = await open(source)
    const { indexer } = provider
    const first = await provider()
    const firstView = indexer.view, snapshot = structuredClone(first)
    expect(await provider()).toBe(first)

    await commitJournal(source.eventLogFile, { currentBlockHeight: 21, scannedBlockHeight: 21, eventCount: 5 }, cursorFile)
    const afterHeartbeat = await provider()

    expect(afterHeartbeat.cursor.currentBlockHeight).toBe(21)
    expect(afterHeartbeat.namesByCanonical).toBe(first.namesByCanonical)
    expect(firstView.projectionBlockHeight).toBe(20)
    expect(first).toEqual(snapshot)
    expect(indexer.stats).toMatchObject({ rebuilds: 1, appliedEvents: 5, viewBuilds: 1 })
  })

  it('leaves a half-written line for the next refresh', async () => {
    const { eventLogFile, source } = await setup(createEventLog())
    const provider = await open(source)
    const line = JSON.stringify(recordEvent('https://two.example', 16))

    await appendFile(eventLogFile, line.slice(0, 40))
    expect(websiteOf(await provider())).toBeNull()

    await appendFile(eventLogFile, `${line.slice(40)}\n`)
    await commitJournal(eventLogFile, { scannedBlockHeight: 20, currentBlockHeight: 20 })
    const store = await provider()
    expect(websiteOf(store)).toBe('https://two.example')
    expect(store.warnings).toEqual([])
  })

  it('ignores lines the collector appends twice', async () => {
    const { eventLogFile, source } = await setup(createEventLog())
    const provider = await open(source)
    const event = recordEvent('https://three.example', 17)

    await appendFile(eventLogFile, lines([event, event]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 20, currentBlockHeight: 20 })
    const store = await provider()

    expect(store.checkpoint).toMatchObject({ eventCount: 6, rawEventCount: 7, duplicateCount: 1 })
    expect(provider.indexer.stats.appliedEvents).toBe(6)
  })

  it('rebuilds when the journal is replaced or shrinks', async () => {
    const { eventLogFile, source } = await setup([...createEventLog(), recordEvent('https://old.example', 15)])
    const provider = await open(source)
    expect(websiteOf(await provider())).toBe('https://old.example')

    await writeFile(eventLogFile, lines(createEventLog()), 'utf8')
    await commitJournal(eventLogFile, { scannedBlockHeight: 20, currentBlockHeight: 20 })
    const store = await provider()

    expect(websiteOf(store)).toBeNull()
    expect(store.checkpoint.eventCount).toBe(5)
    expect(provider.indexer.stats.rebuilds).toBe(2)
  })

  it('resumes from the database and journal offset after a restart', async () => {
    const { eventLogFile, source } = await setup(createEventLog())
    const first = await open(source)
    first.indexer.close()
    providers.splice(providers.indexOf(first), 1)

    await appendFile(eventLogFile, lines([recordEvent('https://four.example', 18)]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 20, currentBlockHeight: 20 })
    const second = await open(source)

    expect(websiteOf(await second())).toBe('https://four.example')
    expect(second.indexer.stats).toMatchObject({ rebuilds: 0, appliedEvents: 6 })
  })

  it('serves the same read models and health as a full import', async () => {
    const events = [...createEventLog(), recordEvent('https://five.example', 19)]
    const { eventLogFile, dir, source } = await setup(createEventLog())
    const provider = await open(source)
    await appendFile(eventLogFile, lines(events.slice(5)))
    await commitJournal(eventLogFile, { scannedBlockHeight: 20, currentBlockHeight: 20 })
    const incremental = await provider()

    const full = await loadSqliteStore(join(dir, 'full.sqlite'), { eventLogFile, cursorFile: source.cursorFile })

    for (const key of ['namesByCanonical', 'namesByAuthority', 'namesByNode', 'recordsByNode', 'reverseByEndpoint', 'subnamesByNode', 'activityByNode']) {
      expect([...incremental[key].entries()]).toEqual([...full[key].entries()])
    }
    expect(incremental.deployment).toEqual(full.deployment)
    expect({ ...incremental.checkpoint, updatedAt: null }).toEqual({ ...full.checkpoint, updatedAt: null })
    expect(incremental.durability.ok).toBe(full.durability.ok)
  })

  it('shares one refresh between concurrent requests', async () => {
    const { eventLogFile, source } = await setup(createEventLog())
    const provider = await open(source)
    await appendFile(eventLogFile, lines([recordEvent('https://six.example', 20)]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 20, currentBlockHeight: 20 })

    const stores = await Promise.all([provider(), provider(), provider()])

    expect(new Set(stores).size).toBe(1)
    expect(provider.indexer.stats.appliedEvents).toBe(6)
  })
})

it('uses finalized coverage for expiry while the live tip crosses a boundary', async () => {
  const { source, cursorFile } = await setup(createEventLog())
  await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: 1001, scannedBlockHeight: 999 }, cursorFile)
  const provider = await open(source)
  expect((await provider()).namesByNode.get(rootNode).status).toBe('active')
  await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: 1002, scannedBlockHeight: 1000 }, cursorFile)
  expect((await provider()).namesByNode.get(rootNode).status).toBe('grace')
  expect(provider.indexer.stats.appliedEvents).toBe(5)
})

it('advances the finalized response clock on a heartbeat without rebuilding the view', async () => {
  const { source, cursorFile } = await setup(createEventLog())
  await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: 102, scannedBlockHeight: 100 }, cursorFile)
  const provider = await open(source), before = provider.indexer.stats.viewBuilds
  await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: 103, scannedBlockHeight: 101 }, cursorFile)
  expect((await provider()).projectionBlockHeight).toBe(101)
  expect(provider.indexer.stats.viewBuilds).toBe(before)
  expect(provider.indexer.stats.appliedEvents).toBe(5)
})

// Exercise both a boundary rebuild and a later heartbeat that only changes the clock.
it.each([[2000, false], [2001, false], [2001, true]])('retains the finalized view at %s when a later batch blocks replay (accepted prefix: %s)', async (height, acceptedPrefix) => {
  const { source, cursorFile, eventLogFile } = await setup(createEventLog())
  const provider = await open(source)
  await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: 2002, scannedBlockHeight: 2000 }, cursorFile)
  await provider()
  if (height > 2000) {
    await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: 2003, scannedBlockHeight: height }, cursorFile)
    // Force a distinct file timestamp on filesystems with coarse write-time resolution.
    await utimes(cursorFile, new Date(), new Date(Date.now() + 1000))
    await provider()
  }
  const last = provider.indexer.view, snapshot = structuredClone(last)
  expect(last.projectionBlockHeight).toBe(height)
  expect(last.namesByNode.get(rootNode).status).toBe('released')
  // Even accepted receipts earlier in an incomplete batch must not leak into the published view.
  const broken = recordEvent('https://broken.example', height + 2)
  broken.event.receipt.events[1].data = 'invalid payload'
  await appendFile(eventLogFile, lines([...(acceptedPrefix ? [recordEvent('https://unpublished.example', height + 1)] : []), broken]))
  for (const scannedBlockHeight of [height + 2, height + 100]) {
    await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: scannedBlockHeight, scannedBlockHeight }, cursorFile)
    const blocked = await provider()
    expect(blocked.projectionBlockHeight).toBe(height)
    expect(provider.indexer.view).toEqual(snapshot)
    expect(blocked.namesByNode.get(rootNode).status).toBe('released')
    expect(resolveForward(blocked, 'aurora.dusk').verificationStatus).not.toBe('forward_resolved')
    expect(healthResponseForStore(blocked).ok).toBe(false)
    expect(blocked.warnings.some(w => w.code === 'invalid_event_log_event')).toBe(true)
  }
  expect(last).toEqual(snapshot)
})

it.each(['event-log', 'sqlite'])('retains the finalized view when a full %s reload blocks replay', async mode => {
  const { source, eventLogFile, cursorFile } = await setup(createEventLog())
  const provider = await createReloadingLocalIndexerStore({ ...source, mode, file: mode === 'event-log' ? eventLogFile : source.file })
  await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: 2002, scannedBlockHeight: 2001 }, cursorFile)
  const last = await provider(), snapshot = structuredClone(last)
  expect(last.projectionBlockHeight).toBe(2001)
  expect(last.namesByNode.get(rootNode).status).toBe('released')
  const broken = recordEvent('https://broken.example', 2002)
  broken.event.receipt.events[1].data = 'invalid payload'
  await appendFile(eventLogFile, lines([broken]))
  for (const height of [2002, 2100]) {
    await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: height, scannedBlockHeight: height }, cursorFile)
    const blocked = await provider()
    expect(blocked.projectionBlockHeight).toBe(2001)
    expect(blocked.namesByNode).toEqual(last.namesByNode)
    expect(blocked.recordsByNode).toEqual(last.recordsByNode)
    expect(resolveForward(blocked, 'aurora.dusk').verificationStatus).not.toBe('forward_resolved')
    expect(healthResponseForStore(blocked).ok).toBe(false)
    expect(blocked.warnings.some(w => w.code === 'invalid_event_log_event')).toBe(true)
  }
  await writeFile(eventLogFile, lines([...createEventLog(), recordEvent('https://repaired.example', 2101)]))
  await commitJournal(source.eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: 2101, scannedBlockHeight: 2101 }, cursorFile)
  const repaired = await provider()
  expect(repaired.projectionBlockHeight).toBe(2101)
  expect(repaired.warnings).toEqual([])
  expect(websiteOf(repaired)).toBe('https://repaired.example')
  expect(last).toEqual(snapshot)
})
