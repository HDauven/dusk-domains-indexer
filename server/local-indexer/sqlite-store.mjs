import { guardCandidate } from './candidate-publication.mjs'
import { committedCursor, loadCommittedJournal, validateCommittedEntries } from './committed-publication.mjs'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { newestEventTimestamp } from './activity.mjs'
import {
  createReplayCheckpoint,
  indexerDurabilityState,
  loadCursor,
} from './checkpoint.mjs'
import {
  dedupeEventLogEntries,
  eventLogEntryKey,
} from './event-log.mjs'
import { deploymentBindingFromEvents } from './deployment-binding.mjs'
import { createReplayState, applyReplayEvent, replayEventLog } from './event-log-store.mjs'
import {
  migrateIndexerDatabase,
  sqliteSchemaState,
} from './sqlite-migrations.mjs'

export const eventsTable = 'events'
const kvTable = 'indexer_kv'

export function loadSqliteStore(dbFile, options = {}) {
  return guardCandidate(options.publication ?? {}, { source: 'local-indexer-sqlite', mode: 'sqlite' },
    candidate => buildSqliteCandidate(dbFile, options, candidate))
}

export async function buildSqliteCandidate(dbFile, options, candidate) {
  candidate.step = 'load-cursor'
  // Capture once before import/row replay, never re-read a newer cursor afterwards.
  let cursor = candidate.cursor = options.cursorFile ? await loadCursor(options.cursorFile) : null
  if (options.cursorFile) candidate.validateCursor()
  candidate.step = 'read-prefix'
  if (options.eventLogFile) {
    await importCandidateRows(dbFile, options.eventLogFile, { ...options, committedCursor: cursor, candidate })
  } else if (!existsSync(dbFile)) {
    throw new Error(`Missing local indexer SQLite database: ${dbFile}. Import an event log first with --sqlite <db> --event-log <jsonl>.`)
  }

  const db = await openIndexerDatabase(dbFile)
  try {
    db.exec('BEGIN')
    const storedCursor = kvGet(db, 'cursor')
    if (!options.cursorFile) {
      cursor = candidate.cursor = storedCursor
      candidate.validateCursor()
    }
    candidate.step = 'read-prefix'
    const rows = db.prepare(`
      SELECT event_json, meta_json
      FROM ${eventsTable}
      ORDER BY id ASC
    `).all()
    const events = rows.map((row) => ({
      event: parseJson(row.event_json, {}),
      meta: parseJson(row.meta_json, {}),
    }))
    const storedWarnings = kvGet(db, 'parse_warnings') ?? []
    const rawEventCount = kvGet(db, 'raw_event_count') ?? events.length
    const now = new Date().toISOString()
    const replayWarnings = candidate.warnings
    replayWarnings.push(...storedWarnings)
    committedCursor(cursor, replayWarnings)
    if (cursor && (storedCursor?.eventLogBytes !== cursor.eventLogBytes || storedCursor?.eventCount !== cursor.eventCount)) {
      replayWarnings.push({ code: 'publication_prefix_mismatch', message: 'SQLite does not contain the prefix committed by this cursor; import the journal.' })
    }
    validateCommittedEntries(events, cursor, replayWarnings, rawEventCount)
    candidate.check()
    const state = replayEventLog(events, replayWarnings, now, cursor.scannedBlockHeight, candidate)
    candidate.view = state
    candidate.step = 'build-views'
    const warnings = uniqueWarnings([...storedWarnings, ...replayWarnings])
    const checkpoint = sqliteReplayCheckpoint(events, rawEventCount, warnings, now)
    candidate.metadata.checkpoint = checkpoint
    const storedCheckpoint = kvGet(db, 'checkpoint')
    const durableCheckpoint = storedCheckpoint
      ? { ok: true, value: storedCheckpoint }
      : { ok: false, message: 'SQLite checkpoint metadata is missing.' }
    const schema = sqliteSchemaState(db)
    const durability = indexerDurabilityState({
      cursor,
      checkpoint,
      durableCheckpoint,
      warnings,
      strictHealth: Boolean(options.strictHealth),
      maxLagBlocks: options.maxLagBlocks,
      eventLogFile: options.eventLogFile ?? kvGet(db, 'event_log_file') ?? null,
      cursorFile: options.cursorFile,
      checkpointFile: dbFile,
    })
    db.exec('COMMIT')
    return {
      generatedAt: newestEventTimestamp(events) ?? now,
      source: 'local-indexer-sqlite',
      mode: 'sqlite',
      sqlite: {
        dbFile,
        journalMode: kvGet(db, 'journal_mode') ?? 'wal',
        importedAt: kvGet(db, 'imported_at'),
        schemaVersion: schema.version,
        expectedSchemaVersion: schema.expectedVersion,
        migrations: schema.migrations,
      },
      warnings,
      deployment: deploymentBindingFromEvents(events),
      cursor,
      checkpoint,
      durableCheckpoint: durableCheckpoint.ok ? durableCheckpoint.value : null,
      durability,
      ...(durability.ok ? {} : { health: {
        ok: false,
        code: durability.code,
        message: durability.message,
      } }),
    }
  } finally {
    db.close()
  }
}

export async function importEventLogToSqlite(dbFile, eventLogFile, options = {}) {
  const store = await loadSqliteStore(dbFile, { ...options, eventLogFile })
  return { dbFile, eventLogFile, checkpoint: store.checkpoint, cursor: store.cursor, warnings: store.warnings,
    eventCount: store.checkpoint?.eventCount ?? null, rawEventCount: store.checkpoint?.rawEventCount ?? null }
}

async function importCandidateRows(dbFile, eventLogFile, options) {
  const cursor = options.committedCursor
  const warnings = []
  const parsedLog = await loadCommittedJournal(eventLogFile, cursor, warnings)
  warnings.push(...parsedLog.warnings)
  validateCommittedEntries(parsedLog.entries, cursor, warnings)
  const events = dedupeEventLogEntries(parsedLog.entries)
  const now = new Date().toISOString()
  // Import is an untrusted replay cache, never a serving publication. Finalization
  // belongs to the guarded candidate that reads these rows (including on restart).
  options.candidate.step = 'replay'
  const replay = createReplayState()
  replay.blocked = warnings.length > 0
  for (const event of events) applyReplayEvent(replay, event, warnings)
  const checkpoint = sqliteReplayCheckpoint(events, parsedLog.entries.length, warnings, now)
  options.candidate.metadata.checkpoint = checkpoint
  options.candidate.step = 'persist'
  const db = await openIndexerDatabase(dbFile)

  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`DELETE FROM ${eventsTable}`)
      db.exec(`DELETE FROM sqlite_sequence WHERE name = '${eventsTable}'`)
      db.prepare(`DELETE FROM ${kvTable} WHERE key = ?`).run('incremental_journal_state')

      const insertEvent = prepareEventInsert(db)
      for (let index = 0; index < events.length; index += 1) {
        insertEvent.run(...eventRow(events[index], index))
      }

      kvSet(db, 'checkpoint', checkpoint, now)
      kvSet(db, 'cursor', cursor, now)
      kvSet(db, 'parse_warnings', warnings, now)
      kvSet(db, 'raw_event_count', parsedLog.entries.length, now)
      kvSet(db, 'event_log_file', eventLogFile, now)
      kvSet(db, 'imported_at', now, now)
      kvSet(db, 'journal_mode', currentJournalMode(db), now)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }

}

// Rows are keyed by the event's identity, so a replayed or re-appended event is ignored
// instead of stored twice.
export function prepareEventInsert(db, { ignoreDuplicates = false } = {}) {
  return db.prepare(`
    INSERT ${ignoreDuplicates ? 'OR IGNORE ' : ''}INTO ${eventsTable} (
      event_key,
      event_type,
      chain_id,
      block_height,
      tx_id,
      event_index,
      contract_key,
      contract_id,
      observed_at,
      event_json,
      meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
}

export function eventRow(entry, index) {
  const event = entry?.event ?? entry
  const meta = entry?.meta ?? {}
  return [
    eventLogEntryKey(entry),
    event?.type ?? 'unknown',
    meta.chainId ?? null,
    integerOrNull(meta.blockHeight),
    meta.txId ?? null,
    integerOrNull(meta.eventIndex ?? index),
    meta.contractKey ?? null,
    meta.contractId ?? null,
    meta.observedAt ?? event?.updatedAt ?? event?.createdAt ?? null,
    JSON.stringify(event ?? {}),
    JSON.stringify(meta ?? {}),
  ]
}

export async function openIndexerDatabase(dbFile) {
  await mkdir(dirname(dbFile), { recursive: true })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA journal_mode = WAL')
  migrateIndexerDatabase(db)
  return db
}

function sqliteReplayCheckpoint(events, rawEventCount, warnings, updatedAt) {
  return {
    ...createReplayCheckpoint(events, rawEventCount, warnings, updatedAt),
    source: 'local-indexer-sqlite',
  }
}

export function kvSet(db, key, value, updatedAt) {
  db.prepare(`
    INSERT INTO ${kvTable}(key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), updatedAt)
}

export function kvGet(db, key) {
  const row = db.prepare(`SELECT value_json FROM ${kvTable} WHERE key = ?`).get(key)
  if (!row) return null
  return parseJson(row.value_json, null)
}

export function currentJournalMode(db) {
  const row = db.prepare('PRAGMA journal_mode').get()
  return row?.journal_mode ?? row?.['journal_mode'] ?? null
}

export function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function integerOrNull(value) {
  if (!Number.isFinite(Number(value))) return null
  return Number(value)
}

function uniqueWarnings(warnings) {
  const seen = new Set()
  return warnings.filter((warning) => {
    const key = JSON.stringify(warning)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
