import { writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkProductionIndexer,
} from './production-indexer-check.mjs'
import { createIndexerBackup } from './indexer-backup.mjs'
import { importEventLogToSqlite } from '../server/local-indexer.mjs'
import {
  cleanupProductionIndexerFixtures,
  writeDurableFixture,
} from './test-fixtures/production-indexer-check.mjs'

afterEach(async () => {
  await cleanupProductionIndexerFixtures()
})

describe('production indexer public-beta evidence gates', () => {
  it('verifies retained archive snapshot evidence when configured', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })
    await writeFile(fixture.archiveSnapshot, 'archive snapshot placeholder', 'utf8')

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      archiveSnapshot: fixture.archiveSnapshot,
      deploymentStartHeight: 10,
      archiveSnapshotHeight: 9,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(result.checks.find((check) => check.id === 'archive_snapshot_height_configured')).toMatchObject({
      ok: true,
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_height')).toMatchObject({
      ok: true,
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_file')).toMatchObject({
      ok: true,
    })
  })

  it('requires explicit archive snapshot evidence for public beta mode', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      requireArchiveSnapshot: true,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'archive_snapshot_required_deployment_start_height')).toMatchObject({
      ok: false,
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_required_height')).toMatchObject({
      ok: false,
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_required_file')).toMatchObject({
      ok: false,
    })
    expect(result.nextStep).toContain('Record deployment start height')
  })

  it('can derive deployment start height from the active event journal', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      requireArchiveSnapshot: true,
      deriveDeploymentStartHeight: true,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.deploymentStartHeight).toBe(10)
    expect(result.derivedDeploymentStartHeight).toBe(10)
    expect(result.checks.find((check) => check.id === 'deployment_start_height_derived')).toMatchObject({
      ok: true,
      message: expect.stringContaining('derived from the earliest core/treasury journal event'),
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_required_deployment_start_height')).toMatchObject({
      ok: true,
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_required_height')).toMatchObject({
      ok: false,
    })
    expect(result.nextStep).toContain('Record archive snapshot height')
    expect(result.nextStep).not.toContain('Record deployment start height')
  })

  it('passes archive retention when deployment start height is derived and snapshot evidence is present', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })
    await writeFile(fixture.archiveSnapshot, 'archive snapshot placeholder', 'utf8')

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      requireArchiveSnapshot: true,
      deriveDeploymentStartHeight: true,
      archiveSnapshotHeight: 9,
      archiveSnapshot: fixture.archiveSnapshot,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(result.deploymentStartHeight).toBe(10)
    expect(result.checks.find((check) => check.id === 'archive_snapshot_height')).toMatchObject({
      ok: true,
      message: expect.stringContaining('covers deployment start height 10'),
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_file')).toMatchObject({
      ok: true,
    })
  })

  it('requires backup manifest and restore staging in public beta mode', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      requireBackup: true,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'backup_manifest_required')).toMatchObject({
      ok: false,
    })
    expect(result.checks.find((check) => check.id === 'backup_restore_dir_required')).toMatchObject({
      ok: false,
    })
    expect(result.nextStep).toContain('Create and verify an indexer backup manifest')
  })

  it('verifies backup manifest and restore staging when configured', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })
    await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })
    const backup = await createIndexerBackup({
      outputDir: fixture.backupDir,
      backupId: 'launch',
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      deploymentProof: fixture.proofReport,
      browserWriteProof: fixture.browserWriteProof,
    })

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      backupManifest: `${backup.outputDir}/manifest.json`,
      backupRestoreDir: fixture.restoreDir,
      requireBackup: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(result.backupVerification).toMatchObject({
      ok: true,
      restoreDir: fixture.restoreDir,
      restoredCount: 6,
    })
    expect(result.checks.find((check) => check.id === 'backup_manifest_verification')).toMatchObject({
      ok: true,
    })
    expect(result.checks.find((check) => check.id === 'backup_file_eventLog_restore')).toMatchObject({
      ok: true,
    })
  })

  it('fails the SQLite backup gate when the manifest lacks the database', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })
    await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })
    const backup = await createIndexerBackup({
      outputDir: fixture.backupDir,
      backupId: 'without-sqlite',
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      deploymentProof: fixture.proofReport,
      browserWriteProof: fixture.browserWriteProof,
    })

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      backupManifest: `${backup.outputDir}/manifest.json`,
      backupRestoreDir: fixture.restoreDir,
      requireBackup: true,
      requireSqliteBackup: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'backup_sqlite_backup_present')).toMatchObject({
      ok: false,
      message: expect.stringContaining('--sqlite <db>'),
    })
  })

  it('passes the SQLite backup gate when the manifest includes the database', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })
    await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })
    const backup = await createIndexerBackup({
      outputDir: fixture.backupDir,
      backupId: 'with-sqlite',
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      deploymentProof: fixture.proofReport,
      browserWriteProof: fixture.browserWriteProof,
      sqliteDb: fixture.sqliteDb,
    })

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      backupManifest: `${backup.outputDir}/manifest.json`,
      backupRestoreDir: fixture.restoreDir,
      requireBackup: true,
      requireSqliteBackup: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(result.requireSqliteBackup).toBe(true)
    expect(result.backupVerification).toMatchObject({
      ok: true,
      restoredCount: 9,
    })
    expect(result.checks.find((check) => check.id === 'backup_sqlite_backup_present')).toMatchObject({
      ok: true,
    })
  })

  it('fails the SQLite serving gate when the database is missing', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })
    const missingSqliteDb = fixture.sqliteDb.replace('indexer.sqlite', 'missing-indexer.sqlite')

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      sqlite: missingSqliteDb,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      requireSqlite: true,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.requireSqlite).toBe(true)
    expect(result.sqlite).toBe(missingSqliteDb)
    expect(result.checks.find((check) => check.id === 'sqlite_file')).toMatchObject({
      ok: false,
      message: expect.stringContaining('Missing SQLite/WAL database'),
    })
    expect(result.nextStep).toContain('Import the event journal into SQLite/WAL')
  })

  it('passes the SQLite serving gate when WAL strict health is safe', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })
    const validSqliteDb = fixture.sqliteDb.replace('indexer.sqlite', 'valid-indexer.sqlite')
    await importEventLogToSqlite(validSqliteDb, fixture.eventLog, {
      cursorFile: fixture.cursor,
    })

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      sqlite: validSqliteDb,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      requireSqlite: true,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(result.sqliteHealth).toMatchObject({
      ok: true,
      mode: 'sqlite',
      eventCount: 2,
    })
    expect(result.checks.find((check) => check.id === 'sqlite_journal_mode')).toMatchObject({
      ok: true,
    })
    expect(result.checks.find((check) => check.id === 'sqlite_route_manifest')).toMatchObject({
      ok: true,
    })
  })

  it('fails derived deployment start height mode without active block metadata', async () => {
    const fixture = await writeDurableFixture({ omitBlockHeight: true })
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      requireArchiveSnapshot: true,
      deriveDeploymentStartHeight: true,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.deploymentStartHeight).toBeNull()
    expect(result.checks.find((check) => check.id === 'deployment_start_height_derived')).toMatchObject({
      ok: false,
      message: expect.stringContaining('no active core/treasury block metadata'),
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_required_deployment_start_height')).toMatchObject({
      ok: false,
    })
  })

  it('does not treat null block heights as deployment height zero', async () => {
    const fixture = await writeDurableFixture({ nullBlockHeight: true })
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      requireArchiveSnapshot: true,
      deriveDeploymentStartHeight: true,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.deploymentStartHeight).toBeNull()
    expect(result.derivedDeploymentStartHeight).toBeNull()
    expect(result.checks.find((check) => check.id === 'deployment_start_height_derived')).toMatchObject({
      ok: false,
      message: expect.stringContaining('no active core/treasury block metadata'),
    })
  })

  it('fails launch-height mode when archive snapshot height is missing', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      deploymentStartHeight: 10,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'archive_snapshot_height_configured')).toMatchObject({
      ok: false,
    })
    expect(result.nextStep).toContain('Record archive snapshot height')
  })
})
