import { rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { healthResponseForStore, loadSqliteStore } from '../../server/local-indexer.mjs'
import { createReloadingLocalIndexerStore } from '../../server/local-indexer/stores.mjs'
import { writeEventLog } from '../test-fixtures/local-indexer-server.mjs'
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

  it('uses the external heartbeat without reimporting SQLite and rejects missing projection events', async () => {
    const { eventLogFile, cursorFile } = await writeEventLog()
    const directory = dirname(eventLogFile)
    const sqlite = join(directory, 'indexer.sqlite')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { checkpoint } = await loadSqliteStore(sqlite, { eventLogFile })
      const cursor = { ...healthyStore().cursor, eventCount: checkpoint.eventCount }
      const importedAt = cursor.updatedAt
      await writeFile(cursorFile, JSON.stringify(cursor))
      await loadSqliteStore(sqlite, { eventLogFile, cursorFile })
      const getStore = await createReloadingLocalIndexerStore({ mode: 'sqlite', file: sqlite, cursorFile })
      expect(healthResponseForStore(await getStore()).ok).toBe(true)

      vi.setSystemTime(Date.now() + 31_000)
      expect(healthResponseForStore(await getStore()).ok).toBe(false)
      cursor.updatedAt = new Date().toISOString()
      cursor.currentBlockHeight = cursor.scannedBlockHeight = 13
      await writeFile(cursorFile, JSON.stringify(cursor))
      expect((await checkSqliteServingProof({ sqlite, cursor: cursorFile })).sqliteHealth.ok).toBe(true)
      expect(healthResponseForStore(await getStore()).ok).toBe(true)
      expect((await loadSqliteStore(sqlite)).cursor.updatedAt).toBe(importedAt)

      cursor.eventCount++
      await writeFile(cursorFile, JSON.stringify(cursor))
      expect((await checkSqliteServingProof({ sqlite, cursor: cursorFile })).sqliteHealth.ok).toBe(false)
      expect(healthResponseForStore(await getStore()).ok).toBe(false)
      expect((await loadSqliteStore(sqlite)).checkpoint.eventCount).toBe(checkpoint.eventCount)
      await writeFile(cursorFile, 'invalid json')
      expect((await loadSqliteStore(sqlite, { cursorFile })).cursor.status).toBe('unreadable')
      await rm(cursorFile)
      expect((await loadSqliteStore(sqlite, { cursorFile })).cursor).toBeNull()
    } finally {
      vi.useRealTimers()
      await rm(directory, { recursive: true, force: true })
    }
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
      source: 'rusk-finalized-archive',
      status: 'running',
      updatedAt: new Date().toISOString(),
      fromBlock: 1,
      scannedBlockHeight: 12,
      scannedBlockHash: '11'.repeat(32),
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
