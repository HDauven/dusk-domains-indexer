import { open, readFile, stat } from 'node:fs/promises'
import { knownChainHeight } from './chain-height.mjs'
import {
  indexerDurabilityState,
  loadCursor,
  replayCheckpointSummary,
} from './checkpoint.mjs'
import {
  addDeploymentBindingEvent,
  createDeploymentBinding,
  summarizeDeploymentBinding,
} from './deployment-binding.mjs'
import { dedupeEventLogEntries, eventTimestamp, parseEventLog } from './event-log.mjs'
import { applyReplayEvent, createReplayState, finalizeReplayState } from './event-log-store.mjs'
import { sqliteSchemaState } from './sqlite-migrations.mjs'
import {
  currentJournalMode,
  eventRow,
  eventsTable,
  kvGet,
  kvSet,
  openIndexerDatabase,
  parseJson,
  prepareEventInsert,
} from './sqlite-store.mjs'

const JOURNAL_STATE_KEY = 'incremental_journal_state'
const NEWLINE = 0x0a

// Serves the SQLite event store while the collector appends to the journal. Each refresh reads
// only the bytes past the last applied offset, stores and applies just those events, and
// reuses the served view when nothing changed. A journal that shrank or was replaced is
// rebuilt from scratch. Concurrent requests share one refresh.
export async function createIncrementalSqliteStore(source) {
  const indexer = new IncrementalSqliteIndexer(source)
  await indexer.start()
  let refreshing = null

  const provider = async () => {
    refreshing ??= indexer.refresh().finally(() => { refreshing = null })
    await refreshing
    return indexer.store
  }
  provider.indexer = indexer
  return provider
}

export class IncrementalSqliteIndexer {
  constructor(source) {
    this.source = source
    this.db = null
    this.store = null
    this.stats = { rebuilds: 0, appliedEvents: 0, viewBuilds: 0 }
  }

  async start() {
    this.db = await openIndexerDatabase(this.source.file)
    const journal = await statOrNull(this.source.eventLogFile)
    const saved = kvGet(this.db, JOURNAL_STATE_KEY)
    if (journal && saved?.format === 'jsonl' && sameFile(saved, journal) && saved.offset <= journal.size) {
      this.loadFromDatabase(saved)
    } else {
      await this.rebuild()
    }
    await this.readCursor(true)
    await this.tail()
    this.buildStore(true)
  }

  close() {
    this.db?.close()
    this.db = null
  }

  async refresh() {
    const applied = await this.tail()
    const cursorChanged = await this.readCursor(false)
    if (!applied && !cursorChanged) return
    const height = knownChainHeight({ cursor: this.cursor })
    const boundary = this.view?.nextLifecycleBoundary
    const crossed = boundary != null && height != null && height >= boundary
    this.buildStore(applied || crossed)
  }

  resetTotals() {
    this.replay = createReplayState()
    this.deployment = createDeploymentBinding()
    this.replayWarnings = []
    this.parseWarnings = []
    this.rawEventCount = 0
    this.eventCount = 0
    this.lastEvent = null
    this.newestTimestampMs = null
    this.importedAt = new Date().toISOString()
  }

  apply(entry) {
    applyReplayEvent(this.replay, entry, this.replayWarnings)
    addDeploymentBindingEvent(this.deployment, entry)
    this.eventCount += 1
    this.stats.appliedEvents += 1
    const event = entry?.event ?? entry
    const meta = entry?.meta ?? {}
    if (event?.type) this.lastEvent = { event, meta }
    const timestamp = Date.parse(eventTimestamp(event, meta) ?? '')
    if (Number.isFinite(timestamp)) this.newestTimestampMs = Math.max(this.newestTimestampMs ?? timestamp, timestamp)
  }

  // Restart path: the rows are already stored, so replay them instead of re-parsing the journal.
  loadFromDatabase(saved) {
    this.resetTotals()
    const rows = this.db.prepare(`SELECT event_json, meta_json FROM ${eventsTable} ORDER BY id ASC`).all()
    for (const row of rows) this.apply({ event: parseJson(row.event_json, {}), meta: parseJson(row.meta_json, {}) })
    this.parseWarnings = kvGet(this.db, 'parse_warnings') ?? []
    this.rawEventCount = kvGet(this.db, 'raw_event_count') ?? this.eventCount
    this.importedAt = kvGet(this.db, 'imported_at') ?? this.importedAt
    this.journal = saved
  }

  async rebuild() {
    this.stats.rebuilds += 1
    this.resetTotals()
    const journal = await statOrNull(this.source.eventLogFile)
    if (!journal) throw new Error(`Missing event log: ${this.source.eventLogFile}`)
    const bytes = await readFile(this.source.eventLogFile)
    const isArray = firstNonSpace(bytes) === 0x5b
    // A line the collector is still writing is left for the next refresh.
    const complete = isArray ? bytes.length : bytes.lastIndexOf(NEWLINE) + 1
    const parsed = parseEventLog(bytes.subarray(0, complete).toString('utf8'))
    const events = dedupeEventLogEntries(parsed.entries)
    this.parseWarnings = [...parsed.warnings]
    this.rawEventCount = parsed.entries.length
    this.journal = {
      format: isArray ? 'array' : 'jsonl',
      dev: journal.dev,
      ino: journal.ino,
      size: journal.size,
      mtimeMs: journal.mtimeMs,
      offset: complete,
      lines: countNewlines(bytes, complete),
    }

    for (const entry of events) this.apply(entry)
    // The stored checkpoint must match the applied totals, so it is written after applying.
    this.guarded(() => this.transaction(() => {
      this.db.exec(`DELETE FROM ${eventsTable}`)
      this.db.exec(`DELETE FROM sqlite_sequence WHERE name = '${eventsTable}'`)
      const insert = prepareEventInsert(this.db)
      events.forEach((entry, index) => insert.run(...eventRow(entry, index)))
      this.persistTotals()
    }))
  }

  // Applies the journal's new complete lines. Returns whether anything changed.
  async tail() {
    const journal = await statOrNull(this.source.eventLogFile)
    if (!journal) return false
    const previous = this.journal
    if (!previous || !sameFile(previous, journal) || journal.size < previous.offset) {
      await this.rebuild()
      return true
    }
    if (previous.format === 'array') {
      if (journal.size === previous.size && journal.mtimeMs === previous.mtimeMs) return false
      await this.rebuild()
      return true
    }
    if (journal.size === previous.offset) return false

    const chunk = await readRange(this.source.eventLogFile, previous.offset, journal.size - previous.offset)
    const complete = chunk.lastIndexOf(NEWLINE) + 1
    if (complete === 0) return false

    const entries = []
    let line = previous.lines
    for (const text of chunk.subarray(0, complete).toString('utf8').split('\n')) {
      line += 1
      if (!text.trim()) continue
      try {
        entries.push(JSON.parse(text))
      } catch (error) {
        this.parseWarnings.push({
          code: 'invalid_event_log_row',
          line,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    line -= 1

    this.guarded(() => this.transaction(() => {
      const insert = prepareEventInsert(this.db, { ignoreDuplicates: true })
      for (const entry of entries) {
        // A row that already exists is a duplicate; only new rows reach the read models.
        if (insert.run(...eventRow(entry, this.eventCount)).changes > 0) this.apply(entry)
      }
      this.rawEventCount += entries.length
      this.journal = { ...previous, size: journal.size, mtimeMs: journal.mtimeMs, offset: previous.offset + complete, lines: line }
      this.persistTotals()
    }))
    return true
  }

  async readCursor(force) {
    const file = this.source.cursorFile
    if (!file) {
      if (force) this.cursor = kvGet(this.db, 'cursor')
      return false
    }
    const cursorStat = await statOrNull(file)
    const signature = cursorStat ? `${cursorStat.mtimeMs}:${cursorStat.size}` : 'missing'
    if (!force && signature === this.cursorSignature) return false
    this.cursorSignature = signature
    this.cursor = await loadCursor(file)
    return true
  }

  checkpoint(updatedAt) {
    return {
      ...replayCheckpointSummary({
        eventCount: this.eventCount,
        rawEventCount: this.rawEventCount,
        warningCount: this.warnings().length,
        last: this.lastEvent,
        updatedAt,
      }),
      source: 'local-indexer-sqlite',
    }
  }

  warnings() {
    return [...this.parseWarnings, ...this.replayWarnings]
  }

  persistTotals() {
    const now = new Date().toISOString()
    this.importedAt = now
    kvSet(this.db, 'checkpoint', this.checkpoint(now), now)
    kvSet(this.db, 'parse_warnings', this.parseWarnings, now)
    kvSet(this.db, 'raw_event_count', this.rawEventCount, now)
    kvSet(this.db, 'event_log_file', this.source.eventLogFile, now)
    kvSet(this.db, 'imported_at', now, now)
    kvSet(this.db, 'journal_mode', currentJournalMode(this.db), now)
    kvSet(this.db, JOURNAL_STATE_KEY, this.journal, now)
  }

  // In-memory state may already hold events a failed write rolled back; forget the journal
  // position so the next refresh rebuilds from the file.
  guarded(work) {
    try {
      work()
    } catch (error) {
      this.journal = null
      throw error
    }
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // The read models change only when events arrive or the chain passes an expiry; health and
  // the cursor are refreshed every time.
  buildStore(rebuildView) {
    const now = new Date().toISOString()
    if (rebuildView || !this.view) {
      this.view = finalizeReplayState(this.replay, now, knownChainHeight({ cursor: this.cursor }))
      this.stats.viewBuilds += 1
    }
    const warnings = this.warnings()
    const checkpoint = this.checkpoint(now)
    const storedCheckpoint = kvGet(this.db, 'checkpoint')
    const durableCheckpoint = storedCheckpoint
      ? { ok: true, value: storedCheckpoint }
      : { ok: false, message: 'SQLite checkpoint metadata is missing.' }
    const schema = sqliteSchemaState(this.db)
    const durability = indexerDurabilityState({
      cursor: this.cursor,
      checkpoint,
      durableCheckpoint,
      warnings,
      strictHealth: Boolean(this.source.strictHealth),
      maxLagBlocks: this.source.maxLagBlocks,
      eventLogFile: this.source.eventLogFile,
      cursorFile: this.source.cursorFile,
      checkpointFile: this.source.file,
    })
    this.store = {
      generatedAt: this.newestTimestampMs === null ? now : new Date(this.newestTimestampMs).toISOString(),
      source: 'local-indexer-sqlite',
      mode: 'sqlite',
      sqlite: {
        dbFile: this.source.file,
        journalMode: kvGet(this.db, 'journal_mode') ?? 'wal',
        importedAt: this.importedAt,
        schemaVersion: schema.version,
        expectedSchemaVersion: schema.expectedVersion,
        migrations: schema.migrations,
      },
      warnings,
      deployment: summarizeDeploymentBinding(this.deployment),
      cursor: this.cursor,
      checkpoint,
      durableCheckpoint: durableCheckpoint.ok ? durableCheckpoint.value : null,
      durability,
      ...(durability.ok ? {} : { health: { ok: false, code: durability.code, message: durability.message } }),
      ...this.view,
    }
  }
}

async function statOrNull(file) {
  try {
    return await stat(file)
  } catch {
    return null
  }
}

function sameFile(saved, current) {
  return saved.dev === current.dev && saved.ino === current.ino
}

async function readRange(file, position, length) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function firstNonSpace(bytes) {
  for (const byte of bytes) if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09) return byte
  return null
}

function countNewlines(bytes, end) {
  let count = 0
  for (let index = 0; index < end; index += 1) if (bytes[index] === NEWLINE) count += 1
  return count
}
