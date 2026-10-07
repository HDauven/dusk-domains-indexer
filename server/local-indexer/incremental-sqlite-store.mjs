import { guardCandidate } from './candidate-publication.mjs'
import { readCommittedJournal } from './committed-publication.mjs'
import { stat } from 'node:fs/promises'
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
  const provider = async () => {
    await indexer.refresh()
    return indexer.store
  }
  provider.indexer = indexer
  return provider
}

export class IncrementalSqliteIndexer {
  constructor(source) {
    this.source = source
    this.db = null
    this.publication = {}
    this.stats = { rebuilds: 0, appliedEvents: 0, viewBuilds: 0 }
  }

  async start() {
    this.resetTotals()
    await this.refresh(true)
  }

  close() {
    this.db?.close()
    this.db = null
  }

  // Single-flight belongs to the indexer itself, including direct refresh callers.
  refresh(starting = false) {
    this.refreshing ??= this.refreshOnce(starting).finally(() => { this.refreshing = null })
    return this.refreshing
  }

  get store() { return this.publication.store }

  get view() { return this.publication.view }

  async refreshOnce(starting) {
    await guardCandidate(this.publication, { source: 'local-indexer-sqlite', mode: 'sqlite' }, async candidate => {
      this.candidate = candidate
      this.publicationWarnings = candidate.warnings
      candidate.step = 'open-database'
      this.db ??= await openIndexerDatabase(this.source.file)
      const previousCursor = JSON.stringify(this.cursor)
      candidate.step = 'load-cursor'
      this.cursor = candidate.cursor = this.source.cursorFile ? await loadCursor(this.source.cursorFile) : kvGet(this.db, 'cursor')
      candidate.validateCursor()
      if (this.replayWarnings.some(w => w.code === 'publication_prefix_mismatch')) this.journal = null
      let applied = false
      try {
        candidate.step = 'read-prefix'
        if (starting) {
          const saved = kvGet(this.db, JOURNAL_STATE_KEY)
          const journal = await statOrNull(this.source.eventLogFile)
          // Rows are only a replay cache; restart must validate and finalize again.
          if (saved?.committed && journal && sameFile(saved, journal)
            && saved.offset <= this.cursor.eventLogBytes && saved.offset <= journal.size
            && !(saved.size === journal.size && saved.mtimeMs !== journal.mtimeMs)) {
            this.loadFromDatabase(saved)
            applied = true
          }
        }
        applied = await this.tail() || applied
      } catch (error) {
        this.journal = null
        throw error
      }
      this.unpublishedChanges ||= applied
      candidate.step = 'validate-prefix'
      if (this.rawEventCount !== this.cursor.eventCount || this.maximumReceiptHeight > this.cursor.scannedBlockHeight) {
        candidate.warnings.push({ code: 'publication_prefix_mismatch', message: 'Committed receipt count or height does not match the journal.' })
      }
      if (this.parseWarnings.length || this.replayWarnings.length) candidate.step = this.parseWarnings.length ? 'read-prefix' : 'replay'
      candidate.warnings.push(...this.parseWarnings, ...this.replayWarnings)
      candidate.check()
      const cursorChanged = previousCursor !== JSON.stringify(this.cursor)
      if (!starting && !this.unpublishedChanges && !cursorChanged && this.publication.view
        && this.publication.store?.health?.code !== 'publication_candidate_rejected') {
        candidate.reuse = true
        return this.publication.store
      }
      const boundary = this.view?.nextLifecycleBoundary
      const crossed = boundary != null && this.cursor.scannedBlockHeight >= boundary
      const store = this.buildStore(this.unpublishedChanges || crossed || starting || !this.view, candidate)
      candidate.step = 'persist'
      kvSet(this.db, 'cursor', this.cursor, new Date().toISOString())
      return store
    })
    // A failure must never make the quiet-heartbeat path look complete. Preserve
    // replay warnings until a repair/rebuild; unexpected partial work forces replay.
    if (this.store.health?.code === 'publication_candidate_rejected') {
      this.unpublishedChanges = true
      if (['finalize', 'build-views', 'persist'].includes(this.store.health.step)) this.journal = null
    } else this.unpublishedChanges = false
  }

  resetTotals() {
    this.replay = createReplayState()
    this.deployment = createDeploymentBinding()
    this.replayWarnings = []
    this.parseWarnings = []
    this.rawEventCount = 0
    this.eventCount = 0
    this.maximumReceiptHeight = 0
    this.lastEvent = null
    this.newestTimestampMs = null
    this.importedAt = new Date().toISOString()
  }

  apply(entry) {
    this.candidate.step = 'replay'
    const height = entry?.meta?.blockHeight
    if (Number.isSafeInteger(height) && height >= 0) this.maximumReceiptHeight = Math.max(this.maximumReceiptHeight, height)
    if (!Number.isSafeInteger(height) || height < 0 || height > this.cursor.scannedBlockHeight) {
      this.replay.blocked = true
      this.replayWarnings.push({ code: 'publication_prefix_mismatch', message: 'Receipt height exceeds the committed finalized height.' })
    }
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
    this.parseWarnings = kvGet(this.db, 'parse_warnings') ?? []
    this.replay.blocked = this.parseWarnings.length > 0
    const rows = this.db.prepare(`SELECT event_json, meta_json FROM ${eventsTable} ORDER BY id ASC`).all()
    for (const row of rows) this.apply({ event: parseJson(row.event_json, {}), meta: parseJson(row.meta_json, {}) })
    this.rawEventCount = kvGet(this.db, 'raw_event_count') ?? this.eventCount
    this.importedAt = kvGet(this.db, 'imported_at') ?? this.importedAt
    this.journal = saved
  }

  async rebuild() {
    this.stats.rebuilds += 1
    this.resetTotals()
    const { bytes, stat: journal } = await readCommittedJournal(this.source.eventLogFile, this.cursor)
    const complete = bytes.length
    const parsed = parseEventLog(bytes.toString('utf8'))
    const events = dedupeEventLogEntries(parsed.entries)
    this.parseWarnings = [...parsed.warnings]
    this.replay.blocked = this.parseWarnings.length > 0
    this.rawEventCount = parsed.entries.length
    this.journal = {
      committed: true, format: 'jsonl', dev: journal.dev, ino: journal.ino,
      size: journal.size, mtimeMs: journal.mtimeMs, offset: complete,
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
    if (!journal) throw new Error(`Missing event log: ${this.source.eventLogFile}`)
    const previous = this.journal
    if (!previous || !sameFile(previous, journal) || journal.size < previous.offset
      || this.cursor.eventLogBytes < previous.offset
      || (journal.size === previous.size && journal.mtimeMs !== previous.mtimeMs)) {
      await this.rebuild()
      return true
    }
    if (journal.size < this.cursor.eventLogBytes) throw new Error('Journal is shorter than its committed cursor.')
    if (this.cursor.eventLogBytes === previous.offset) return false

    const { bytes: chunk, stat: loaded } = await readCommittedJournal(this.source.eventLogFile, this.cursor, previous.offset)
    // If a repair replaced the path between stat and open, replay the new prefix.
    if (!sameFile(previous, loaded)) { await this.rebuild(); return true }
    const complete = chunk.length

    const entries = []
    let line = previous.lines
    for (const text of chunk.subarray(0, complete).toString('utf8').split('\n')) {
      line += 1
      if (!text.trim()) continue
      try {
        entries.push(JSON.parse(text))
      } catch (error) {
        this.replay.blocked = true
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
    return [...new Set([...this.parseWarnings, ...this.replayWarnings, ...(this.publicationWarnings ?? [])])]
  }

  persistTotals() {
    this.candidate.step = 'persist'
    const now = new Date().toISOString()
    this.importedAt = now
    kvSet(this.db, 'cursor', this.cursor, now)
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
    this.candidate.step = 'persist'
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
  buildStore(rebuildView, candidate) {
    const now = new Date().toISOString()
    const height = this.cursor.scannedBlockHeight
    candidate.step = 'finalize'
    if (rebuildView) {
      // Finalization may retain a view for offline callers; isolate that assignment
      // from the accumulator and the serving owner until the entire build succeeds.
      candidate.view = finalizeReplayState({ ...this.replay, lastCompleteView: null }, now, height, candidate.warnings)
      this.stats.viewBuilds += 1
    } else candidate.view = { ...this.view, projectionBlockHeight: height }
    candidate.check()
    candidate.step = 'build-views'
    const warnings = candidate.warnings
    const checkpoint = this.checkpoint(now)
    candidate.metadata.checkpoint = checkpoint
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
    return {
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
    }
  }
}

async function statOrNull(file) {
  try {
    return await stat(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

function sameFile(saved, current) {
  return saved.dev === current.dev && saved.ino === current.ino
}

function countNewlines(bytes, end) {
  let count = 0
  for (let index = 0; index < end; index += 1) if (bytes[index] === NEWLINE) count += 1
  return count
}
