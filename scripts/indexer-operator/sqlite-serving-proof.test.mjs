import { describe, expect, it } from 'vitest'
import { checkSqliteServingProof } from './sqlite-serving-proof.mjs'

describe('sqlite serving proof', () => {
  it('requires a configured SQLite path when public beta policy demands it', async () => {
    const result = await checkSqliteServingProof({
      requireSqlite: true,
    })

    expect(result.sqliteHealth).toBeNull()
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'sqlite_configured',
        ok: false,
        message: 'Public beta SQLite policy requires --sqlite.',
      }),
    ]))
  })

  it('checks WAL health and public routes for a SQLite store', async () => {
    const result = await checkSqliteServingProof({
      cursor: 'cursor.json',
      exists: () => true,
      loadStore: async (sqlite, options) => {
        expect(sqlite).toBe('indexer.sqlite')
        expect(options).toMatchObject({
          cursorFile: 'cursor.json',
          maxLagBlocks: 12,
          strictHealth: true,
        })
        return healthyStore()
      },
      requiredRoutes: ['/health', '/resolve'],
      requireSqlite: true,
      sqlite: 'indexer.sqlite',
    })

    expect(result.sqliteHealth).toMatchObject({
      ok: true,
      eventCount: 2,
      mode: 'sqlite',
    })
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sqlite_configured', ok: true }),
      expect.objectContaining({ id: 'sqlite_file', ok: true }),
      expect.objectContaining({ id: 'sqlite_strict_health', ok: true }),
      expect.objectContaining({ id: 'sqlite_event_count', ok: true }),
      expect.objectContaining({ id: 'sqlite_journal_mode', ok: true }),
      expect.objectContaining({ id: 'sqlite_schema_version', ok: true }),
      expect.objectContaining({ id: 'sqlite_route_manifest', ok: true }),
    ]))
  })

  it('fails closed when the SQLite store cannot be loaded', async () => {
    const result = await checkSqliteServingProof({
      exists: () => true,
      loadStore: async () => {
        throw new Error('file is not a database')
      },
      sqlite: 'indexer.sqlite',
    })

    expect(result.sqliteHealth).toBeNull()
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'sqlite_strict_health',
        ok: false,
        message: expect.stringContaining('file is not a database'),
      }),
    ]))
  })

  it('reports unsafe route or journal mode evidence', async () => {
    const result = await checkSqliteServingProof({
      exists: () => true,
      loadStore: async () => ({
        ...healthyStore(),
        sqlite: {
          dbFile: 'indexer.sqlite',
          journalMode: 'delete',
          schemaVersion: 2,
          expectedSchemaVersion: 1,
        },
      }),
      requiredRoutes: ['/health', '/missing-route'],
      sqlite: 'indexer.sqlite',
    })

    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'sqlite_journal_mode',
        ok: false,
        message: expect.stringContaining('expected wal'),
      }),
      expect.objectContaining({
        id: 'sqlite_route_manifest',
        ok: false,
        message: expect.stringContaining('/missing-route'),
      }),
      expect.objectContaining({
        id: 'sqlite_schema_version',
        ok: false,
        message: expect.stringContaining('does not match expected'),
      }),
    ]))
  })
})

function healthyStore() {
  return {
    generatedAt: '2026-06-28T00:00:00.000Z',
    source: 'local-indexer-sqlite',
    mode: 'sqlite',
    sqlite: {
      dbFile: 'indexer.sqlite',
      journalMode: 'wal',
      schemaVersion: 1,
      expectedSchemaVersion: 1,
    },
    namesByCanonical: new Map(),
    warnings: [],
    cursor: {
      currentBlockHeight: 12,
      eventCount: 2,
      lastBlockHeight: 12,
      lastEventName: 'name_registered',
      lastTxId: 'tx-register',
    },
    checkpoint: {
      eventCount: 2,
      lastBlockHeight: 12,
      lastEventName: 'name_registered',
      lastTxId: 'tx-register',
    },
    durability: {
      ok: true,
    },
  }
}
