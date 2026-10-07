import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { createReloadingLocalIndexerStore } from './stores.mjs'
import { createLocalIndexerHandler } from './routes.mjs'
import { deploymentBindingFromEvents, deploymentEvents } from './deployment-binding.mjs'
import { eventTimestamp, confirmedEventBlockHeight } from './event-log.mjs'
import { createReplayState, applyReplayEvent } from './frozen-view.mjs'
import { auditEventJournalDeploymentBinding } from '../../scripts/indexer-operator/event-journal-binding.mjs'
import { createEventLog, envelope, receipt, recordEffects, rootNode } from '../../scripts/test-fixtures/frozen-events.mjs'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { malformedRows } from '../../scripts/test-fixtures/malformed-rows.mjs'

const cleanup = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const lines = entries => entries.map(e => JSON.stringify(e) + '\n').join('')
const response = (provider, url) => new Promise(resolve => {
  let status
  createLocalIndexerHandler(provider, { logger: { warn() {}, error() {} } })(
    { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    { writeHead(s) { status = s }, end(body) { resolve({ status, body }) } })
})
async function setup(mode) {
  const dir = await mkdtemp(join(tmpdir(), 'publication-validation-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const eventLogFile = join(dir, 'events.jsonl'), cursorFile = join(dir, 'cursor.json')
  const source = { mode, eventLogFile, cursorFile, file: mode === 'event-log' ? eventLogFile : join(dir, 'events.sqlite') }
  const commit = (height, overrides = {}) => commitJournal(eventLogFile,
    { scannedBlockHeight: height, currentBlockHeight: height + 2, ...overrides }, cursorFile)
  const open = async () => {
    const provider = mode === 'incremental' ? await createIncrementalSqliteStore(source) : await createReloadingLocalIndexerStore(source)
    cleanup.push(() => provider.indexer?.close())
    return provider
  }
  await writeFile(eventLogFile, lines(createEventLog())); await commit(998)
  return { provider: await open(), open, eventLogFile, commit }
}

it.each(['event-log', 'incremental', 'sqlite'])('revalidates unpublished receipts after a rejected count and lower corrected cursor: %s', async mode => {
  const { provider, eventLogFile, commit, open } = await setup(mode)
  const before = await provider()
  const high = envelope(receipt(2000, recordEffects('https://unpublished.example'), 'edit-high'))
  await appendFile(eventLogFile, lines([high]))
  await commit(2000, { eventCount: createEventLog().length + 2 })
  expect((await provider()).projectionBlockHeight).toBe(998)
  await commit(1500)
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = await provider()
    expect(store.projectionBlockHeight).toBe(998)
    expect(store.namesByNode).toBe(before.namesByNode)
    expect(store.recordHistoryByNodeKey.get(`${rootNode}:website`)).toBeUndefined()
    expect(store.warnings.some(w => w.code === 'publication_prefix_mismatch')).toBe(true)
  }
  // Restart must validate the persisted accumulator too; it has no retained publication.
  provider.indexer?.close()
  const cold = await open()
  expect((await response(cold, '/names')).status).toBe(503)
  await commit(2000)
  const recovered = await cold()
  expect(recovered.projectionBlockHeight).toBe(2000)
  expect(recovered.recordHistoryByNodeKey.get(`${rootNode}:website`).map(e => e.blockHeight)).toEqual([2000])
  expect(recovered.warnings).toEqual([])
})

for (const mode of ['event-log', 'incremental', 'sqlite']) {
  it.each(malformedRows)('retains live reads, withholds cold reads, and repairs malformed $label rows: ' + mode, async ({ row }) => {
    const { provider, open, eventLogFile, commit } = await setup(mode)
    const before = await response(provider, '/names')
    expect(before.status).toBe(200)
    await appendFile(eventLogFile, lines([row])); await commit(999)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await response(provider, '/names')).toEqual(before)
      const health = await response(provider, '/health')
      expect(health.status).toBe(200)
      expect(JSON.parse(health.body).ok).toBe(false)
      expect(JSON.parse(health.body).projectionBlockHeight).toBe(998)
      expect((await provider()).warnings.length).toBeGreaterThan(0)
    }
    provider.indexer?.close()
    const cold = await open()
    expect((await response(cold, '/names')).status).toBe(503)
    const health = await response(cold, '/health')
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body).ok).toBe(false)
    expect(JSON.parse(health.body).projectionBlockHeight).toBeNull()
    await writeFile(eventLogFile + '.tmp', lines(createEventLog()))
    await rename(eventLogFile + '.tmp', eventLogFile); await commit(999)
    expect((await response(cold, '/names')).status).toBe(200)
    expect((await cold()).warnings).toEqual([])
  })
}

it.each(malformedRows)('reports rejected $label rows through replay and deployment diagnostics', async ({ row }) => {
  const state = createReplayState(), warnings = []
  expect(() => applyReplayEvent(state, row, warnings)).not.toThrow()
  expect(state.blocked).toBe(true)
  expect(warnings[0].code).toBe('invalid_event_log_event')
  expect(() => eventTimestamp(row, null)).not.toThrow()
  expect(() => confirmedEventBlockHeight(row, { source: 'w3sper-live-subscription' })).not.toThrow()
  expect(() => deploymentBindingFromEvents([...createEventLog(), row])).not.toThrow()
  expect(() => deploymentEvents([...createEventLog(), row])).not.toThrow()
  const { eventLogFile } = await setup('event-log')
  await appendFile(eventLogFile, lines([row]))
  await expect(auditEventJournalDeploymentBinding({ eventLog: eventLogFile, deploymentStartHeight: null,
    archiveSnapshotHeight: null })).resolves.toHaveProperty('checks')
})
