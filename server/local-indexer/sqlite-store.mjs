import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
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
  parseEventLog,
} from './event-log.mjs'
import { deploymentBindingFromEvents } from './deployment-binding.mjs'
import { replayEventLog } from './event-log-store.mjs'
import {
  migrateIndexerDatabase,
  sqliteSchemaState,
} from './sqlite-migrations.mjs'

const eventsTable = 'events'
const kvTable = 'indexer_kv'
let DatabaseSyncConstructor = null

export async function loadSqliteStore(dbFile, options = {}) {
  if (options.eventLogFile) {
    await importEventLogToSqlite(dbFile, options.eventLogFile, options)
  } else if (!existsSync(dbFile)) {
    throw new Error(`Missing local indexer SQLite database: ${dbFile}. Import an event log first with --sqlite <db> --event-log <jsonl>.`)
  }

  const db = await openIndexerDatabase(dbFile)
  try {
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
    const replayWarnings = []
    const state = replayEventLog(events, replayWarnings, now)
    const warnings = uniqueWarnings([...storedWarnings, ...replayWarnings])
    const checkpoint = sqliteReplayCheckpoint(events, rawEventCount, warnings, now)
    const storedCheckpoint = kvGet(db, 'checkpoint')
    const durableCheckpoint = storedCheckpoint
      ? { ok: true, value: storedCheckpoint }
      : { ok: false, message: 'SQLite checkpoint metadata is missing.' }
    const cursor = kvGet(db, 'cursor') ?? await loadCursor(options.cursorFile)
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
      ...state,
    }
  } finally {
    db.close()
  }
}

export async function importEventLogToSqlite(dbFile, eventLogFile, options = {}) {
  const parsedLog = parseEventLog(await readFile(eventLogFile, 'utf8'))
  const events = dedupeEventLogEntries(parsedLog.entries)
  const warnings = [...parsedLog.warnings]
  const now = new Date().toISOString()
  replayEventLog(events, warnings, now)
  const checkpoint = sqliteReplayCheckpoint(events, parsedLog.entries.length, warnings, now)
  const cursor = await loadCursor(options.cursorFile)
  const db = await openIndexerDatabase(dbFile)

  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`DELETE FROM ${eventsTable}`)
      db.exec(`DELETE FROM sqlite_sequence WHERE name = '${eventsTable}'`)

      const insertEvent = db.prepare(`
        INSERT INTO ${eventsTable} (
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

      for (let index = 0; index < events.length; index += 1) {
        const entry = events[index]
        const event = entry?.event ?? entry
        const meta = entry?.meta ?? {}
        insertEvent.run(
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
        )
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

  return {
    dbFile,
    eventLogFile,
    checkpoint,
    cursor,
    warnings,
    eventCount: events.length,
    rawEventCount: parsedLog.entries.length,
  }
}

async function openIndexerDatabase(dbFile) {
  await mkdir(dirname(dbFile), { recursive: true })
  const DatabaseSync = await databaseSync()
  const db = new DatabaseSync(dbFile)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA journal_mode = WAL')
  migrateIndexerDatabase(db)
  return db
}

async function databaseSync() {
  if (DatabaseSyncConstructor) return DatabaseSyncConstructor
  const sqlite = await import('node:sqlite')
  DatabaseSyncConstructor = sqlite.DatabaseSync
  return DatabaseSyncConstructor
}

function sqliteReplayCheckpoint(events, rawEventCount, warnings, updatedAt) {
  return {
    ...createReplayCheckpoint(events, rawEventCount, warnings, updatedAt),
    source: 'local-indexer-sqlite',
  }
}

function kvSet(db, key, value, updatedAt) {
  db.prepare(`
    INSERT INTO ${kvTable}(key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), updatedAt)
}

function kvGet(db, key) {
  const row = db.prepare(`SELECT value_json FROM ${kvTable} WHERE key = ?`).get(key)
  if (!row) return null
  return parseJson(row.value_json, null)
}

function currentJournalMode(db) {
  const row = db.prepare('PRAGMA journal_mode').get()
  return row?.journal_mode ?? row?.['journal_mode'] ?? null
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function integerOrNull(value) {
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
