import { expect, it } from 'vitest'
import { appendFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReloadingLocalIndexerStore } from './stores.mjs'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { createEventLog, envelope, receipt, recordEffects, rootName, bytes, rootNode } from '../../scripts/test-fixtures/frozen-events.mjs'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'

// A committed-prefix identity guards the incremental cache even when an
// operator violates the documented atomic-replacement repair procedure.
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('')
const transfer = who => envelope(receipt(30, [[4, 'authorities_changed', { name: { ...rootName(), owner: bytes(who), manager: bytes(who) },
  actor: bytes(10), previous_owner: bytes(10), previous_manager: bytes(11), data_cleared: false, reason: 'Holder' }]], 'transfer'))
const later = envelope(receipt(31, [[4, 'commitment_created', { commitment: { key: { actor: bytes(50), hash: bytes(51) }, created_at: 31n } }]], 'later'))

it('rebuilds incremental SQLite after an in-place committed-prefix rewrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'indexer-finding-'))
  const eventLogFile = join(directory, 'events.jsonl'), cursorFile = join(directory, 'cursor.json')
  let incremental
  try {
    await writeFile(eventLogFile, jsonl([...createEventLog(), transfer(20)]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 100, currentBlockHeight: 100 }, cursorFile)
    const eventLog = await createReloadingLocalIndexerStore({ mode: 'event-log', file: eventLogFile, cursorFile })
    incremental = await createIncrementalSqliteStore({ mode: 'sqlite', file: join(directory, 'incremental.sqlite'), eventLogFile, cursorFile })
    expect((await incremental()).namesByNode.get(rootNode).owner).toBe(`0x${'14'.repeat(32)}`)
    // Same inode and committed byte length, with an uncommitted suffix so file
    // metadata changes without moving the cursor.
    await writeFile(eventLogFile, jsonl([...createEventLog(), transfer(30), later]))
    const expected = await eventLog(), actual = await incremental()
    expect(expected.warnings).toEqual([])
    expect(expected.namesByNode.get(rootNode).owner).toBe(`0x${'1e'.repeat(32)}`)
    expect(actual.warnings).toEqual([])
    expect(actual.namesByNode.get(rootNode).owner).toBe(expected.namesByNode.get(rootNode).owner)
  } finally {
    incremental?.indexer.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([
  ['metadata text', candidate => { candidate.meta.contractKey = false }],
  ['event timestamp fallback', candidate => { candidate.meta.observedAt = null; candidate.event.updatedAt = { bad: true } }],
])('rejects malformed %s consistently in every storage mode', async (_label, mutate) => {
  const directory = await mkdtemp(join(tmpdir(), 'indexer-finding-'))
  const eventLogFile = join(directory, 'events.jsonl'), cursorFile = join(directory, 'cursor.json')
  let incremental
  try {
    await writeFile(eventLogFile, jsonl(createEventLog()))
    await commitJournal(eventLogFile, { scannedBlockHeight: 100, currentBlockHeight: 100 }, cursorFile)
    const eventLog = await createReloadingLocalIndexerStore({ mode: 'event-log', file: eventLogFile, cursorFile })
    const sqlite = await createReloadingLocalIndexerStore({ mode: 'sqlite', file: join(directory, 'reload.sqlite'), eventLogFile, cursorFile })
    incremental = await createIncrementalSqliteStore({ mode: 'sqlite', file: join(directory, 'incremental.sqlite'), eventLogFile, cursorFile })
    const candidate = envelope(receipt(110, recordEffects('https://candidate.example'), 'candidate'))
    mutate(candidate)
    await appendFile(eventLogFile, jsonl([candidate]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 111, currentBlockHeight: 111 }, cursorFile)
    const views = { eventLog: await eventLog(), sqlite: await sqlite(), incremental: await incremental() }
    for (const view of Object.values(views)) {
      expect(view.projectionBlockHeight).toBe(100)
      expect(view.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_event_log_metadata' }),
      ]))
    }
  } finally {
    incremental?.indexer.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('requires current primary authority in every storage mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'indexer-finding-'))
  const eventLogFile = join(directory, 'events.jsonl'), cursorFile = join(directory, 'cursor.json')
  let incremental
  try {
    await writeFile(eventLogFile, jsonl(createEventLog()))
    await commitJournal(eventLogFile, { scannedBlockHeight: 100, currentBlockHeight: 100 }, cursorFile)
    const eventLog = await createReloadingLocalIndexerStore({ mode: 'event-log', file: eventLogFile, cursorFile })
    const sqlite = await createReloadingLocalIndexerStore({ mode: 'sqlite', file: join(directory, 'reload.sqlite'), eventLogFile, cursorFile })
    incremental = await createIncrementalSqliteStore({ mode: 'sqlite', file: join(directory, 'incremental.sqlite'), eventLogFile, cursorFile })
    await appendFile(eventLogFile, jsonl([transfer(20)]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 100, currentBlockHeight: 100 }, cursorFile)
    const views = { eventLog: await eventLog(), sqlite: await sqlite(), incremental: await incremental() }
    for (const view of Object.values(views)) {
      expect(view.warnings).toEqual([])
      expect(view.reverseByEndpoint.size).toBe(0)
    }
  } finally {
    incremental?.indexer.close()
    await rm(directory, { recursive: true, force: true })
  }
})
