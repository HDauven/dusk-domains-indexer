import { expect, it } from 'vitest'
import { appendFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReloadingLocalIndexerStore } from './stores.mjs'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { createEventLog, envelope, receipt, recordEffects, rootName, bytes, rootNode } from '../../scripts/test-fixtures/frozen-events.mjs'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'

// Open finding, pinned until fixed. Found by ingestion/adversarial-rows
// (fast-check 4.10.2, seed 20261010, shrunk to values [0] and one truncated
// candidate row): its repair rewrote the journal in place. The incremental
// SQLite store (`--sqlite --event-log --watch`) treats a same-inode journal that
// grew as append-only and resumes at its old byte offset, so committed bytes
// rewritten in place are never re-read. When the rewritten row keeps its length
// (here a transfer to another 32-byte owner), it silently serves the old state;
// otherwise it rejects with invalid_event_log_row. The event-log and SQLite
// reload stores publish the rewritten journal.
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('')
const transfer = who => envelope(receipt(30, [[4, 'authorities_changed', { name: { ...rootName(), owner: bytes(who), manager: bytes(who) },
  actor: bytes(10), previous_owner: bytes(10), previous_manager: bytes(11), data_cleared: false, reason: 'Holder' }]], 'transfer'))
const later = envelope(receipt(31, [[4, 'commitment_created', { commitment: { key: { actor: bytes(50), hash: bytes(51) }, created_at: 31n } }]], 'later'))

it('finding_incremental_in_place_rewrite: incremental SQLite must publish the same journal as the event-log store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'indexer-finding-'))
  const eventLogFile = join(directory, 'events.jsonl'), cursorFile = join(directory, 'cursor.json')
  let incremental
  try {
    await writeFile(eventLogFile, jsonl([...createEventLog(), transfer(20)]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 100, currentBlockHeight: 100 }, cursorFile)
    const eventLog = await createReloadingLocalIndexerStore({ mode: 'event-log', file: eventLogFile, cursorFile })
    incremental = await createIncrementalSqliteStore({ mode: 'sqlite', file: join(directory, 'incremental.sqlite'), eventLogFile, cursorFile })
    expect((await incremental()).namesByNode.get(rootNode).owner).toBe(`0x${'14'.repeat(32)}`)
    // Same inode, same row length, one more committed row.
    await writeFile(eventLogFile, jsonl([...createEventLog(), transfer(30), later]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 100, currentBlockHeight: 100 }, cursorFile)
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

// Shrunk from ingestion/adversarial-rows (fast-check 4.10.2, seed 20263021,
// path 17:0:0:0:1:4:11:10:37:9:10:10). The common journal reader accepts a
// boolean contractKey, but SQLite tries to bind it directly and rejects the
// entire candidate. Event-log publication advances while both SQLite modes
// retain the preceding state.
it('finding_sqlite_metadata_type_divergence: all storage modes must make the same publication decision', async () => {
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
    candidate.meta.contractKey = false
    await appendFile(eventLogFile, jsonl([candidate]))
    await commitJournal(eventLogFile, { scannedBlockHeight: 111, currentBlockHeight: 111 }, cursorFile)
    const views = { eventLog: await eventLog(), sqlite: await sqlite(), incremental: await incremental() }
    expect(views.eventLog.warnings).toEqual([])
    expect.soft(views.sqlite.warnings).toEqual([])
    expect.soft(views.incremental.warnings).toEqual([])
  } finally {
    incremental?.indexer.close()
    await rm(directory, { recursive: true, force: true })
  }
})
