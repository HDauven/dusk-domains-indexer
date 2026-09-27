import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createIncrementalSqliteStore } from './local-indexer/incremental-sqlite-store.mjs'
import { loadSqliteStore } from './local-indexer/sqlite-store.mjs'
import { createEventLog, writeCursor } from './local-indexer-test-helpers.mjs'

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
  await writeCursor({ currentBlockHeight: 20, scannedBlockHeight: 20, eventCount: events.length }, cursorFile)
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
  return {
    event: {
      type: 'record_changed',
      node: `0x${'aa'.repeat(32)}`,
      controller: '0xowner',
      record: { key: 'website', value, visibility: 'public', updatedAt: '2026-06-17T00:00:03.000Z', ttlSeconds: 300 },
    },
    meta: { txId: `tx-${blockHeight}`, blockHeight },
  }
}

function websiteOf(store) {
  return store.recordsByNode.get(`0x${'aa'.repeat(32)}`)?.find((record) => record.key === 'website')?.value ?? null
}

describe('incremental SQLite store', () => {
  it('applies appended journal lines without replaying the journal', async () => {
    const { eventLogFile, source } = await setup(createEventLog())
    const provider = await open(source)
    const { indexer } = provider
    expect(indexer.stats).toMatchObject({ rebuilds: 1, appliedEvents: 5 })

    await appendFile(eventLogFile, lines([recordEvent('https://one.example', 15)]))
    const store = await provider()

    expect(websiteOf(store)).toBe('https://one.example')
    expect(indexer.stats).toMatchObject({ rebuilds: 1, appliedEvents: 6 })
    expect(store.checkpoint).toMatchObject({ eventCount: 6, lastBlockHeight: 15 })
  })

  it('does no replay work for a cursor heartbeat or an unchanged journal', async () => {
    const { cursorFile, source } = await setup(createEventLog())
    const provider = await open(source)
    const { indexer } = provider
    const first = await provider()
    expect(await provider()).toBe(first)

    await writeCursor({ currentBlockHeight: 21, scannedBlockHeight: 21, eventCount: 5 }, cursorFile)
    const afterHeartbeat = await provider()

    expect(afterHeartbeat.cursor.currentBlockHeight).toBe(21)
    expect(afterHeartbeat.namesByCanonical).toBe(first.namesByCanonical)
    expect(indexer.stats).toMatchObject({ rebuilds: 1, appliedEvents: 5, viewBuilds: 1 })
  })

  it('leaves a half-written line for the next refresh', async () => {
    const { eventLogFile, source } = await setup(createEventLog())
    const provider = await open(source)
    const line = JSON.stringify(recordEvent('https://two.example', 16))

    await appendFile(eventLogFile, line.slice(0, 40))
    expect(websiteOf(await provider())).toBeNull()

    await appendFile(eventLogFile, `${line.slice(40)}\n`)
    const store = await provider()
    expect(websiteOf(store)).toBe('https://two.example')
    expect(store.warnings).toEqual([])
  })

  it('ignores lines the collector appends twice', async () => {
    const { eventLogFile, source } = await setup(createEventLog())
    const provider = await open(source)
    const event = recordEvent('https://three.example', 17)

    await appendFile(eventLogFile, lines([event, event]))
    const store = await provider()

    expect(store.checkpoint).toMatchObject({ eventCount: 6, rawEventCount: 7, duplicateCount: 1 })
    expect(provider.indexer.stats.appliedEvents).toBe(6)
  })

  it('rebuilds when the journal is replaced or shrinks', async () => {
    const { eventLogFile, source } = await setup([...createEventLog(), recordEvent('https://old.example', 15)])
    const provider = await open(source)
    expect(websiteOf(await provider())).toBe('https://old.example')

    await writeFile(eventLogFile, lines(createEventLog()), 'utf8')
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
    const second = await open(source)

    expect(websiteOf(await second())).toBe('https://four.example')
    expect(second.indexer.stats).toMatchObject({ rebuilds: 0, appliedEvents: 6 })
  })

  it('serves the same read models and health as a full import', async () => {
    const events = [...createEventLog(), recordEvent('https://five.example', 19)]
    const { eventLogFile, dir, source } = await setup(createEventLog())
    const provider = await open(source)
    await appendFile(eventLogFile, lines(events.slice(5)))
    const incremental = await provider()

    const full = await loadSqliteStore(join(dir, 'full.sqlite'), { eventLogFile, cursorFile: source.cursorFile })

    for (const key of ['namesByCanonical', 'namesByNode', 'recordsByNode', 'reverseByEndpoint', 'subnamesByNode', 'activityByNode']) {
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

    const stores = await Promise.all([provider(), provider(), provider()])

    expect(new Set(stores).size).toBe(1)
    expect(provider.indexer.stats.appliedEvents).toBe(6)
  })
})
