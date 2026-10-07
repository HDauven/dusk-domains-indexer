import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { importEventLogToSqlite, loadSqliteStore } from './sqlite-store.mjs'
import { createReloadingLocalIndexerStore } from './stores.mjs'
import { createLocalIndexerHandler } from './routes.mjs'
import { healthResponseForStore } from './health.mjs'
import { createReplayState, applyReplayEvent, finalizeReplayState } from './frozen-view.mjs'
import { createEventLog } from '../../scripts/test-fixtures/frozen-events.mjs'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { finalizationFaults } from '../../scripts/test-fixtures/publication-faults.mjs'

const faults = vi.hoisted(() => ({ step: null, hit(step) { if (step === this.step) throw new Error(`Injected ${step} failure`) } }))
vi.mock('./checkpoint.mjs', async original => {
  const module = await original()
  return { ...module, loadCursor: (...args) => { faults.hit('load-cursor'); return module.loadCursor(...args) } }
})
vi.mock('./committed-publication.mjs', async original => {
  const module = await original()
  return { ...module,
    committedCursor: (...args) => { faults.hit('validate-cursor'); return module.committedCursor(...args) },
    loadCommittedJournal: (...args) => { faults.hit('read-prefix'); return module.loadCommittedJournal(...args) },
    readCommittedJournal: (...args) => { faults.hit('read-prefix'); return module.readCommittedJournal(...args) },
  }
})
vi.mock('./frozen-view.mjs', async original => {
  const module = await original()
  return { ...module,
    applyReplayEvent: (...args) => { faults.hit('replay'); return module.applyReplayEvent(...args) },
    finalizeReplayState: (...args) => { faults.hit('finalize'); return module.finalizeReplayState(...args) },
  }
})
vi.mock('./deployment-binding.mjs', async original => {
  const module = await original()
  return { ...module,
    deploymentBindingFromEvents: (...args) => { faults.hit('build-views'); return module.deploymentBindingFromEvents(...args) },
    summarizeDeploymentBinding: (...args) => { faults.hit('build-views'); return module.summarizeDeploymentBinding(...args) },
  }
})
const cleanup = []
afterEach(async () => { faults.step = null; for (const fn of cleanup.splice(0).reverse()) await fn() })
const response = (provider, url) => new Promise(resolve => {
  let status
  createLocalIndexerHandler(provider, { logger: { warn() {}, error() {} } })(
    { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    { writeHead(s) { status = s }, end(body) { resolve({ status, body: JSON.parse(body) }) } })
})

for (const mode of ['event-log', 'incremental', 'sqlite']) {
  it.each(['load-cursor', 'validate-cursor', 'read-prefix', 'replay', 'finalize', 'build-views'])(
    `rejects exceptions at %s before publishing or caching: ${mode}`, async step => {
      const dir = await mkdtemp(join(tmpdir(), 'candidate-boundary-'))
      cleanup.push(() => rm(dir, { recursive: true, force: true }))
      const eventLogFile = join(dir, 'events.jsonl'), cursorFile = join(dir, 'cursor.json')
      const source = { mode, eventLogFile, cursorFile, file: mode === 'event-log' ? eventLogFile : join(dir, 'events.sqlite') }
      const open = async () => {
        const provider = mode === 'incremental' ? await createIncrementalSqliteStore(source) : await createReloadingLocalIndexerStore(source)
        cleanup.push(() => provider.indexer?.close())
        return provider
      }
      const commit = height => commitJournal(eventLogFile, { scannedBlockHeight: height, currentBlockHeight: height + 2 }, cursorFile)
      await writeFile(eventLogFile, createEventLog().map(e => JSON.stringify(e) + '\n').join('')); await commit(998)
      const provider = await open(), before = await provider(), snapshot = structuredClone(before)
      const names = await response(provider, '/names')
      // Replacing the prefix forces both replay and finalization, even with no new receipts.
      await writeFile(eventLogFile, createEventLog().map(e => JSON.stringify(e) + '\n').join('')); await commit(999)
      faults.step = step
      for (let repeat = 0; repeat < 2; repeat++) {
        const stores = await Promise.all([provider(), provider(), provider()])
        expect(new Set(stores).size).toBe(1)
        expect(stores[0].namesByNode).toBe(before.namesByNode)
        expect(stores[0].projectionBlockHeight).toBe(998)
        expect(healthResponseForStore(stores[0]).degradedReason).toMatchObject({ step, message: `Injected ${step} failure` })
        expect(await response(provider, '/names')).toEqual(names)
        expect(await response(provider, '/health')).toMatchObject({ status: 200, body: { ok: false, degradedReason: { step, error: 'Error' } } })
      }
      expect(before).toEqual(snapshot)
      provider.indexer?.close()
      const cold = await open()
      expect(await response(cold, '/names')).toMatchObject({ status: 503 })
      expect(await response(cold, '/health')).toMatchObject({ status: 200, body: { ok: false, projectionBlockHeight: null } })
      faults.step = null
      expect((await cold()).projectionBlockHeight).toBe(999)
      expect(await response(cold, '/health')).toMatchObject({ status: 200, body: { ok: true } })
    })
}

it.each(finalizationFaults)('generates a $label receipt that passes replay and fails only at finalization', ({ row }) => {
  const state = createReplayState(), warnings = []
  for (const entry of [...createEventLog(), row()]) applyReplayEvent(state, entry, warnings)
  expect(warnings).toEqual([])
  expect(state.blocked).toBe(false)
  expect(() => finalizeReplayState(state, new Date().toISOString(), 999)).toThrow()
})

it.each(finalizationFaults)('diagnoses $label through public SQLite import and database-only reload', async ({ row }) => {
  const dir = await mkdtemp(join(tmpdir(), 'candidate-import-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const eventLogFile = join(dir, 'events.jsonl'), cursorFile = join(dir, 'cursor.json'), dbFile = join(dir, 'events.sqlite')
  await writeFile(eventLogFile, [...createEventLog(), row()].map(e => JSON.stringify(e) + '\n').join(''))
  await commitJournal(eventLogFile, { scannedBlockHeight: 999, currentBlockHeight: 1002 }, cursorFile)
  const imported = await importEventLogToSqlite(dbFile, eventLogFile, { cursorFile })
  expect(imported.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'finalize', error: 'AssertionError' })]))
  const store = await loadSqliteStore(dbFile)
  expect(store.unavailable).toBe(true)
  expect(healthResponseForStore(store)).toMatchObject({ ok: false, degradedReason: { step: 'finalize' } })
})
