import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEventLogStore } from '../server/local-indexer.mjs'
import {
  closeServer,
  expectJson,
  startIndexer as startIndexerFixture,
  writeEventLog as writeEventLogFixture,
} from './test-fixtures/local-indexer-server.mjs'

const tempDirs = []
const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeEventLog(options = {}) {
  return writeEventLogFixture(options, { trackTempDir: (dir) => tempDirs.push(dir) })
}

async function startIndexer(store, handlerOptions = {}) {
  return startIndexerFixture(store, {
    handlerOptions,
    trackServer: (server) => servers.push(server),
  })
}

describe('local indexer malformed event-log handling', () => {
  it('withholds malformed event-log history while reporting replay warnings', async () => {
    const fixture = await writeEventLog({ malformedRow: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
      ok: false,
      mode: 'event-log',
      names: 0,
      projectionBlockHeight: null,
      warnings: expect.arrayContaining([expect.objectContaining({ code: 'invalid_event_log_row', line: 2 })]),
    })
    await expect(expectJson(`${baseUrl}/resolve?name=aurora`, { expectedStatus: 503 })).resolves.toMatchObject({ error: 'incomplete_replay' })
  })

  it('keeps health alive for malformed event-log array sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-local-indexer-bad-array-test-'))
    tempDirs.push(dir)
    const eventLogFile = join(dir, 'events.json')
    await writeFile(eventLogFile, '[{"event":', 'utf8')
    const store = await loadEventLogStore(eventLogFile, null)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
      ok: false,
      mode: 'event-log',
      names: 0,
      projectionBlockHeight: null,
      warnings: [{ code: 'publication_candidate_rejected', step: 'validate-cursor', error: 'Error' }, {
        code: 'publication_cursor_unavailable',
      }],
    })
    await expect(expectJson(`${baseUrl}/search?query=aurora`, { expectedStatus: 503 })).resolves.toMatchObject({ error: 'incomplete_replay' })
  })

  it('withholds the reconstructed prefix when a cold receipt replay blocks', async () => {
    const fixture = await writeEventLog({ malformedEvent: true })
    const store = await loadEventLogStore(fixture.eventLogFile, fixture.cursorFile)
    const { baseUrl } = await startIndexer(store)

    await expect(expectJson(`${baseUrl}/health`)).resolves.toMatchObject({
      ok: false,
      mode: 'event-log',
      names: 0,
      projectionBlockHeight: null,
      warnings: [{ code: 'publication_candidate_rejected', step: 'replay', error: 'Error' }, {
        code: 'invalid_event_log_event',
        type: 'frozen_receipt',
      }],
    })
    await expect(expectJson(`${baseUrl}/resolve?name=aurora`, { expectedStatus: 503 })).resolves.toMatchObject({ error: 'incomplete_replay' })
    await expect(expectJson(`${baseUrl}/activity?node=${fixture.node}`, { expectedStatus: 503 })).resolves.toMatchObject({ error: 'incomplete_replay' })
  })
})
