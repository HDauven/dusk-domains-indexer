import { LOCAL_INDEXER_SQLITE_SCHEMA_VERSION } from './constants.mjs'

export const migrationsTable = 'schema_migrations'

const migrations = Object.freeze([
  {
    version: 1,
    name: 'initial_event_ledger',
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_key TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          chain_id TEXT,
          block_height INTEGER,
          tx_id TEXT,
          event_index INTEGER,
          contract_key TEXT,
          contract_id TEXT,
          observed_at TEXT,
          event_json TEXT NOT NULL,
          meta_json TEXT NOT NULL
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS indexer_kv (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS events_height_idx ON events(block_height, tx_id, event_index)')
      db.exec('CREATE INDEX IF NOT EXISTS events_type_idx ON events(event_type)')
      db.exec('CREATE INDEX IF NOT EXISTS events_contract_idx ON events(contract_key, contract_id)')
    },
  },
])

export function migrateIndexerDatabase(db, now = new Date().toISOString()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${migrationsTable} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)
  const maxRow = db.prepare(`SELECT MAX(version) AS version FROM ${migrationsTable}`).get()
  const currentVersion = Number(maxRow?.version ?? 0)
  if (currentVersion > LOCAL_INDEXER_SQLITE_SCHEMA_VERSION) {
    throw new Error(`SQLite schema version ${currentVersion} is newer than supported version ${LOCAL_INDEXER_SQLITE_SCHEMA_VERSION}.`)
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue
    migration.apply(db)
    db.prepare(`
      INSERT INTO ${migrationsTable}(version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, now)
  }

  return sqliteSchemaState(db)
}

export function sqliteSchemaState(db) {
  const rows = db.prepare(`
    SELECT version, name, applied_at
    FROM ${migrationsTable}
    ORDER BY version ASC
  `).all()
  const version = rows.reduce((max, row) => Math.max(max, Number(row.version ?? 0)), 0)
  return {
    version,
    expectedVersion: LOCAL_INDEXER_SQLITE_SCHEMA_VERSION,
    migrations: rows.map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      appliedAt: String(row.applied_at),
    })),
  }
}
