import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { createReloadingLocalIndexerStore } from './stores.mjs'
import { loadSqliteStore } from './sqlite-store.mjs'
import { healthResponseForStore } from './health.mjs'
import { createEventLog, envelope, receipt, recordEffects, rootNode } from '../../scripts/test-fixtures/frozen-events.mjs'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'

const hooks = vi.hoisted(() => ({ afterCursor: null }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal()
  return { ...fs, readFile: async (...args) => {
    const bytes = await fs.readFile(...args)
    if (String(args[0]).endsWith('/cursor.json')) await hooks.afterCursor?.()
    return bytes
  } }
})
const cleanup = []
afterEach(async () => { hooks.afterCursor = null; for (const fn of cleanup.splice(0)) await fn() })
const lines = entries => entries.map(e => JSON.stringify(e) + '\n').join('')
const edit = height => envelope(receipt(height, recordEffects(`https://edit-${height}.example`)))
async function setup(mode, height = 998) {
  const dir = await mkdtemp(join(tmpdir(), 'publication-race-'))
  let provider
  cleanup.push(async () => { provider?.indexer?.close(); await rm(dir, { recursive: true, force: true }) })
  const eventLogFile = join(dir, 'events.jsonl'), cursorFile = join(dir, 'cursor.json')
  const source = { mode, eventLogFile, cursorFile, file: mode === 'event-log' ? eventLogFile : join(dir, 'events.sqlite') }
  await writeFile(eventLogFile, lines(createEventLog()))
  const commit = (height, overrides = {}) => commitJournal(eventLogFile, { scannedBlockHeight: height, currentBlockHeight: height + 2, ...overrides }, cursorFile)
  await commit(height)
  provider = mode === 'incremental' ? await createIncrementalSqliteStore(source) : await createReloadingLocalIndexerStore(source)
  return { provider, source, commit, eventLogFile, cursorFile }
}

it.each(['event-log', 'incremental', 'sqlite'])('ignores appended complete and malformed crash tails until the cursor commits them: %s', async mode => {
  const { provider, commit, eventLogFile } = await setup(mode)
  await appendFile(eventLogFile, lines([edit(1001)]))
  const before = await provider()
  expect(before.projectionBlockHeight).toBe(998)
  expect(before.namesByNode.get(rootNode).status).toBe('active')
  expect(before.recordHistoryByNodeKey.get(`${rootNode}:website`)).toBeUndefined()
  expect(before.warnings).toEqual([])
  await appendFile(eventLogFile, '{half-row')
  expect((await provider()).warnings).toEqual([])
  await writeFile(eventLogFile + '.tmp', lines([...createEventLog(), edit(1001)]))
  await rename(eventLogFile + '.tmp', eventLogFile)
  await commit(1001)
  const after = await provider()
  expect(after.projectionBlockHeight).toBe(1001)
  expect(after.namesByNode.get(rootNode).status).toBe('grace')
  expect(after.recordHistoryByNodeKey.get(`${rootNode}:website`)).toHaveLength(1)
})

it.each(['event-log', 'incremental', 'sqlite'])('retains a repair through cursor loss and a lower valid cursor: %s', async mode => {
  const { provider, commit, eventLogFile, cursorFile } = await setup(mode, 2001)
  const before = await provider()
  await writeFile(cursorFile, '{unreadable')
  await writeFile(eventLogFile + '.tmp', lines(createEventLog()))
  await rename(eventLogFile + '.tmp', eventLogFile)
  for (const height of [null, 14, 2002]) {
    if (height !== null) await commit(height)
    const store = await provider()
    expect(store.projectionBlockHeight).toBe(height === 2002 ? 2002 : 2001)
    expect(store.namesByNode.get(rootNode).status).toBe('released')
    if (height !== 2002) {
      expect(store.namesByNode).toBe(before.namesByNode)
      expect(healthResponseForStore(store).ok).toBe(false)
    }
  }
})

it.each(['event-log', 'incremental', 'sqlite'])('serializes requests and keeps the cache signature bound to the actual load: %s', async mode => {
  const { provider, commit, eventLogFile } = await setup(mode, 20)
  await appendFile(eventLogFile, lines([edit(21)])); await commit(21)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let reads = 0
  hooks.afterCursor = async () => { if (++reads === 1) { entered.resolve(); await release.promise } }
  const first = provider()
  await entered.promise
  await appendFile(eventLogFile, lines([edit(22)])); await commit(22)
  const later = [provider(), provider()]
  // Let a racing implementation reach its independent cursor read deterministically.
  await new Promise(resolve => setTimeout(resolve, 25))
  const readsWhileBlocked = reads
  release.resolve()
  const stores = await Promise.all([first, ...later])
  expect(readsWhileBlocked).toBe(1)
  expect(new Set(stores).size).toBe(1)
  const latest = await provider()
  expect(latest.projectionBlockHeight).toBe(22)
  expect(latest.recordHistoryByNodeKey.get(`${rootNode}:website`).map(e => e.blockHeight)).toEqual([22, 21])
})

it.each(['event-log', 'incremental', 'sqlite'])('withholds cold incomplete cursor prefixes and recovers after a matching commit: %s', async mode => {
  const { provider, source, commit, eventLogFile } = await setup(mode)
  await appendFile(eventLogFile, lines([edit(1001)]))
  await commit(998) // Committed receipt lies above the finalized clock.
  let cold
  if (mode === 'incremental') { provider.indexer.close(); cold = await createIncrementalSqliteStore(source); cleanup.unshift(() => cold.indexer.close()) }
  else cold = await createReloadingLocalIndexerStore(source)
  expect((await cold()).unavailable).toBe(true)
  await commit(1001)
  expect((await cold()).projectionBlockHeight).toBe(1001)
  await commit(1002, { eventCount: 1000 })
  expect((await cold()).projectionBlockHeight).toBe(1001)
  await commit(1003)
  expect((await cold()).projectionBlockHeight).toBe(1003)
})

it('does not pair a database prefix with a newer external cursor position', async () => {
  const { source, commit, eventLogFile } = await setup('sqlite', 20)
  await appendFile(eventLogFile, lines([edit(21)])); await commit(21)
  const store = await loadSqliteStore(source.file, { cursorFile: source.cursorFile })
  expect(store.unavailable).toBe(true)
  expect(store.warnings.some(w => w.code === 'publication_prefix_mismatch')).toBe(true)
})
