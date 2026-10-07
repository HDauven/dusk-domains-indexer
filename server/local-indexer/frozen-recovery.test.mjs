import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { appendFile, rename, writeFile, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { createReloadingLocalIndexerStore } from './stores.mjs'
import { loadEventLogStore } from './event-log-store.mjs'
import { loadSqliteStore } from './sqlite-store.mjs'
import { resolveForward } from './read-models/forward.mjs'
import { healthResponseForStore } from './health.mjs'
import { startServer, writeEventLog } from '../local-indexer-test-helpers.mjs'
import { createEventLog, envelope, receipt, recordEffects, rootNode } from '../../scripts/test-fixtures/frozen-events.mjs'

const providers = []
afterEach(() => { for (const provider of providers.splice(0)) provider.indexer.close() })
const lines = entries => entries.map(e => JSON.stringify(e) + '\n').join('')
const edit = (height, value = 'https://unpublished.example') => envelope(receipt(height, recordEffects(value)))
const broken = height => {
  const entry = edit(height)
  entry.event.receipt.events[1].data = 'invalid payload'
  return entry
}
async function setup() {
  const eventLogFile = await writeEventLog(createEventLog())
  const cursorFile = join(dirname(eventLogFile), 'cursor.json')
  const source = { mode: 'sqlite', file: join(dirname(eventLogFile), 'indexer.sqlite'), eventLogFile, cursorFile }
  let writes = 0
  const cursor = async height => {
    await commitJournal(eventLogFile, { source: 'rusk-finalized-archive', currentBlockHeight: height + 1, scannedBlockHeight: height }, cursorFile)
    await utimes(cursorFile, new Date(), new Date(Date.now() + ++writes * 1000))
  }
  await cursor(20)
  return { source, eventLogFile, cursor }
}
async function open(source) {
  const provider = await createIncrementalSqliteStore(source)
  providers.push(provider)
  return provider
}
async function replace(file, text) {
  await writeFile(file + '.replacement', text)
  await rename(file + '.replacement', file)
}
async function published(provider, cursor) {
  await cursor(2000); await provider()
  await cursor(2001)
  const last = await provider()
  expect(last.projectionBlockHeight).toBe(2001)
  expect(last.namesByNode.get(rootNode).status).toBe('released')
  return last
}
function retained(store, last) {
  expect(store.projectionBlockHeight).toBe(2001)
  for (const field of ['namesByNode', 'recordsByNode', 'activityByNode', 'reverseByEndpoint']) expect(store[field]).toBe(last[field])
  expect(resolveForward(store, 'aurora.dusk').verificationStatus).toBe('unverified')
  expect(healthResponseForStore(store).ok).toBe(false)
}

it.each(['replacement', 'shrink'])('retains the publication across a blocked live journal %s', async kind => {
  const { source, eventLogFile, cursor } = await setup()
  if (kind === 'shrink') await appendFile(eventLogFile, '\n'.repeat(20000))
  const provider = await open(source), last = await published(provider, cursor), snapshot = structuredClone(last)
  await appendFile(eventLogFile, lines([broken(2002)]))
  await cursor(2002)
  retained(await provider(), last)
  const text = lines([...createEventLog(), broken(2002)])
  if (kind === 'replacement') await replace(eventLogFile, text)
  else await writeFile(eventLogFile, text)
  await cursor(2100)
  const rebuilt = await provider()
  expect(provider.indexer.stats.rebuilds).toBe(2)
  retained(rebuilt, last)
  await cursor(2101); retained(await provider(), last)
  await replace(eventLogFile, lines([...createEventLog(), edit(2102, 'https://repaired.example')]))
  await cursor(2102)
  const repaired = await provider()
  expect(repaired.warnings).toEqual([])
  expect(repaired.projectionBlockHeight).toBe(2102)
  expect(repaired.recordsByNode.get(rootNode).at(-1).value).toBe('https://repaired.example')
  expect(last).toEqual(snapshot)
})

it.each(['database', 'rebuild', 'event-log', 'sqlite'])('withholds the prefix after blocked cold reconstruction via %s', async mode => {
  const { source, eventLogFile, cursor } = await setup()
  const provider = await open(source)
  await published(provider, cursor)
  await appendFile(eventLogFile, lines([broken(2002)]))
  await cursor(2002)
  await provider()
  provider.indexer.close()
  await cursor(2100)
  let store
  if (mode === 'rebuild') await replace(eventLogFile, lines([...createEventLog(), broken(2002)]))
  if (mode === 'database' || mode === 'rebuild') {
    const restarted = await open(source)
    store = await restarted()
    expect(restarted.indexer.stats.rebuilds).toBe(mode === 'database' ? 0 : 1)
  } else store = mode === 'event-log'
    ? await loadEventLogStore(eventLogFile, source.cursorFile)
    : await loadSqliteStore(source.file, { cursorFile: source.cursorFile })
  expect(store.namesByNode.size).toBe(0)
  expect(store.projectionBlockHeight).toBeNull()
  expect(store.unavailable).toBe(true)
  expect(store.reverseByEndpoint.size).toBe(0)
  expect(resolveForward(store, 'aurora.dusk').verificationStatus).toBe('unverified')
  const server = await startServer(store, { logger: { warn() {} } })
  try {
    const health = await fetch(server.baseUrl + '/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: false, projectionBlockHeight: null })
    for (const path of ['/resolve?name=aurora', '/search?query=aurora', '/reverse?type=moonlight_address&value=unused',
      `/records?node=${rootNode}`, '/names', '/page/name/aurora.dusk', '/share/name/aurora.dusk', '/sitemap/names.xml']) {
      const response = await fetch(server.baseUrl + path)
      expect(response.status, path).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ error: 'incomplete_replay' })
    }
  } finally { await server.close() }
})

it.each(['incremental', 'event-log', 'sqlite'])('blocks a malformed row and later receipts in %s refreshes', async mode => {
  const { source, eventLogFile, cursor } = await setup()
  const provider = mode === 'incremental' ? await open(source) : await createReloadingLocalIndexerStore({
    ...source, mode, file: mode === 'event-log' ? eventLogFile : source.file,
  })
  const last = await published(provider, cursor), snapshot = structuredClone(last)
  await appendFile(eventLogFile, lines([edit(2002)]) + '{malformed\n' + lines([edit(2003, 'https://after-gap.example')]))
  await cursor(2003)
  const blocked = await provider()
  expect(blocked.warnings.some(w => w.code === 'invalid_event_log_row')).toBe(true)
  retained(blocked, last)
  await appendFile(eventLogFile, lines([edit(2004)]))
  await cursor(2100); retained(await provider(), last)
  if (mode === 'incremental') {
    const restarted = await open(source)
    expect(restarted.indexer.stats.rebuilds).toBe(0)
    expect((await restarted()).unavailable).toBe(true)
  }
  if (mode !== 'event-log') {
    const saved = await loadSqliteStore(source.file, { cursorFile: source.cursorFile })
    expect(saved.unavailable).toBe(true)
    expect(saved.namesByNode.size).toBe(0)
  }
  await replace(eventLogFile, lines([...createEventLog(), edit(2101, 'https://repaired.example')]))
  await cursor(2101)
  const repaired = await provider()
  expect(repaired.projectionBlockHeight).toBe(2101)
  expect(repaired.warnings).toEqual([])
  expect(repaired.recordsByNode.get(rootNode).at(-1).value).toBe('https://repaired.example')
  expect(last).toEqual(snapshot)
})

it.each(['incremental', 'event-log', 'sqlite'])('blocks malformed history on the initial %s import', async mode => {
  const { source, eventLogFile, cursor } = await setup()
  await appendFile(eventLogFile, '{malformed\n' + lines([edit(21)]))
  await cursor(21)
  const store = mode === 'incremental' ? await (await open(source))() : mode === 'event-log'
    ? await loadEventLogStore(eventLogFile, source.cursorFile)
    : await loadSqliteStore(source.file, { eventLogFile, cursorFile: source.cursorFile })
  expect(store.warnings.some(w => w.code === 'invalid_event_log_row')).toBe(true)
  expect(store.namesByNode.size).toBe(0)
  expect(store.unavailable).toBe(true)
})
