import { existsSync } from 'node:fs'
import {
  healthResponseForStore,
  loadSqliteStore,
} from '../../server/local-indexer.mjs'

export async function checkSqliteServingProof({
  cursor = '',
  exists = existsSync,
  loadStore = loadSqliteStore,
  maxLagBlocks = 12,
  requiredRoutes = [],
  requireSqlite = false,
  sqlite = '',
} = {}) {
  const checks = []
  const push = (id, ok, message) => checks.push({ id, ok, message })
  let sqliteHealth = null

  if (requireSqlite) {
    push('sqlite_configured', Boolean(sqlite), sqlite
      ? `SQLite/WAL database is configured: ${sqlite}.`
      : 'Public beta SQLite policy requires --sqlite.')
  }

  if (sqlite) {
    const sqliteExists = exists(sqlite)
    push('sqlite_file', sqliteExists, sqliteExists
      ? `SQLite/WAL database exists: ${sqlite}`
      : `Missing SQLite/WAL database: ${sqlite}`)

    if (sqliteExists) {
      try {
        const store = await loadStore(sqlite, {
          cursorFile: cursor,
          strictHealth: true,
          maxLagBlocks,
        })
        sqliteHealth = healthResponseForStore(store)
        const journalMode = String(store.sqlite?.journalMode ?? '').toLowerCase()

        push('sqlite_strict_health', sqliteHealth.ok === true, sqliteHealth.ok
          ? 'SQLite/WAL strict indexer health is safe.'
          : sqliteHealth.durability?.message ?? 'SQLite/WAL strict indexer health is unsafe.')
        push('sqlite_event_count', Number(sqliteHealth.eventCount ?? 0) > 0, Number(sqliteHealth.eventCount ?? 0) > 0
          ? `SQLite/WAL health reports ${sqliteHealth.eventCount} event(s).`
          : 'SQLite/WAL health reports no indexed events.')
        push('sqlite_journal_mode', journalMode === 'wal', journalMode === 'wal'
          ? 'SQLite database is using WAL mode.'
          : `SQLite database journal mode is ${store.sqlite?.journalMode ?? 'unknown'}, expected wal.`)
        push('sqlite_schema_version', store.sqlite?.schemaVersion === store.sqlite?.expectedSchemaVersion, store.sqlite?.schemaVersion === store.sqlite?.expectedSchemaVersion
          ? `SQLite schema version ${store.sqlite?.schemaVersion} is current.`
          : `SQLite schema version ${store.sqlite?.schemaVersion ?? 'unknown'} does not match expected ${store.sqlite?.expectedSchemaVersion ?? 'unknown'}.`)

        const missingRoutes = requiredRoutes.filter((route) => !sqliteHealth.routes?.includes(route))
        push('sqlite_route_manifest', missingRoutes.length === 0, missingRoutes.length === 0
          ? 'SQLite/WAL route manifest exposes all public indexer routes.'
          : `SQLite/WAL route manifest is missing: ${missingRoutes.join(', ')}.`)
      } catch (error) {
        push('sqlite_strict_health', false, `Could not load SQLite/WAL indexer state: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return {
    checks,
    sqliteHealth,
  }
}
