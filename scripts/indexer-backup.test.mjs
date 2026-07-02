import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createIndexerBackup,
  parseArgs,
  verifyIndexerBackup,
} from './indexer-backup.mjs'

const tempDirs = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('indexer backup', () => {
  it('parses operator options', () => {
    expect(parseArgs([
      '--output-dir',
      'backups',
      '--backup-id',
      'launch-1',
      '--verify',
      '--manifest',
      'backups/launch-1/manifest.json',
      '--restore-dir',
      'restore',
      '--event-log',
      'events.jsonl',
      '--cursor',
      'cursor.json',
      '--checkpoint',
      'checkpoint.json',
      '--env-file',
      '.env.production',
      '--deployment-proof',
      'proof.json',
      '--browser-write-proof',
      'browser.json',
      '--sqlite',
      'indexer.sqlite',
      '--require-sqlite',
    ])).toEqual({
      help: false,
      outputDir: 'backups',
      backupId: 'launch-1',
      verify: true,
      manifest: 'backups/launch-1/manifest.json',
      restoreDir: 'restore',
      eventLog: 'events.jsonl',
      cursor: 'cursor.json',
      checkpoint: 'checkpoint.json',
      envFile: '.env.production',
      deploymentProof: 'proof.json',
      browserWriteProof: 'browser.json',
      sqliteDb: 'indexer.sqlite',
      requireSqlite: true,
    })
  })

  it('copies required files and writes checksum manifest', async () => {
    const dir = await tempDir()
    const fixture = await writeBackupFixture(dir)
    const result = await createIndexerBackup({
      outputDir: join(dir, 'backups'),
      backupId: 'launch',
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      deploymentProof: fixture.deploymentProof,
      browserWriteProof: fixture.browserWriteProof,
      sqliteDb: fixture.sqliteDb,
    })

    expect(result.ok).toBe(true)
    expect(result.copied).toHaveLength(9)
    expect(result.copied.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256))).toBe(true)
    const manifest = JSON.parse(await readFile(join(dir, 'backups', 'launch', 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      ok: true,
      backupId: 'launch',
      copied: expect.arrayContaining([
        expect.objectContaining({ key: 'eventLog' }),
        expect.objectContaining({ key: 'deploymentProof' }),
        expect.objectContaining({ key: 'sqliteDb' }),
        expect.objectContaining({ key: 'sqliteWal' }),
        expect.objectContaining({ key: 'sqliteShm' }),
      ]),
    })
  })

  it('requires the configured SQLite database but treats clean sidecars as optional', async () => {
    const dir = await tempDir()
    const fixture = await writeBackupFixture(dir)
    const result = await createIndexerBackup({
      outputDir: join(dir, 'backups'),
      backupId: 'sqlite-missing',
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      deploymentProof: fixture.deploymentProof,
      sqliteDb: join(dir, 'missing.sqlite'),
    })

    expect(result.ok).toBe(false)
    expect(result.missing).toEqual([
      expect.objectContaining({ key: 'sqliteDb', required: true }),
    ])
    expect(result.missing).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'sqliteWal' }),
      expect.objectContaining({ key: 'sqliteShm' }),
    ]))
  })

  it('fails when a required file is missing but still writes a manifest', async () => {
    const dir = await tempDir()
    const fixture = await writeBackupFixture(dir)
    const result = await createIndexerBackup({
      outputDir: join(dir, 'backups'),
      backupId: 'missing',
      eventLog: join(dir, 'missing-events.jsonl'),
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      deploymentProof: fixture.deploymentProof,
    })

    expect(result.ok).toBe(false)
    expect(result.missing).toEqual([
      expect.objectContaining({ key: 'eventLog', required: true }),
    ])
    await expect(readFile(join(dir, 'backups', 'missing', 'manifest.json'), 'utf8')).resolves.toContain('missing-events.jsonl')
  })

  it('verifies checksummed backup files and stages a restore directory', async () => {
    const dir = await tempDir()
    const fixture = await writeBackupFixture(dir)
    const backup = await createIndexerBackup({
      outputDir: join(dir, 'backups'),
      backupId: 'launch',
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      deploymentProof: fixture.deploymentProof,
      browserWriteProof: fixture.browserWriteProof,
      sqliteDb: fixture.sqliteDb,
    })
    const manifest = join(backup.outputDir, 'manifest.json')
    const movedManifest = JSON.parse(await readFile(manifest, 'utf8'))
    movedManifest.copied = movedManifest.copied.map((file) => ({
      ...file,
      destination: join(dir, 'moved-from-original-path', file.destination.split('/').at(-1)),
    }))
    await writeFile(manifest, `${JSON.stringify(movedManifest, null, 2)}\n`, 'utf8')

    const result = await verifyIndexerBackup({
      manifest,
      restoreDir: join(dir, 'restore'),
      requireSqlite: true,
    })

    expect(result.ok).toBe(true)
    expect(result.restored).toHaveLength(9)
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'manifest_readable', ok: true }),
      expect.objectContaining({ id: 'manifest_ok', ok: true }),
      expect.objectContaining({ id: 'sqlite_backup_present', ok: true }),
      expect.objectContaining({ id: 'file_eventLog_checksum', ok: true }),
      expect.objectContaining({ id: 'file_eventLog_restore', ok: true }),
    ]))
    await expect(readFile(result.restored.find((file) => file.key === 'eventLog').path, 'utf8'))
      .resolves.toBe('eventLog\n')
    await expect(readFile(result.restored.find((file) => file.key === 'sqliteDb').path, 'utf8'))
      .resolves.toBe('sqliteDb\n')
  })

  it('fails required SQLite verification when the manifest lacks a database copy', async () => {
    const dir = await tempDir()
    const fixture = await writeBackupFixture(dir)
    const backup = await createIndexerBackup({
      outputDir: join(dir, 'backups'),
      backupId: 'without-sqlite',
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      deploymentProof: fixture.deploymentProof,
      browserWriteProof: fixture.browserWriteProof,
    })

    const result = await verifyIndexerBackup({
      manifest: join(backup.outputDir, 'manifest.json'),
      restoreDir: join(dir, 'restore'),
      requireSqlite: true,
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'sqlite_backup_present')).toMatchObject({
      ok: false,
      message: expect.stringContaining('--sqlite <db>'),
    })
  })

  it('fails verification when a backed-up file is corrupted', async () => {
    const dir = await tempDir()
    const fixture = await writeBackupFixture(dir)
    const backup = await createIndexerBackup({
      outputDir: join(dir, 'backups'),
      backupId: 'launch',
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      deploymentProof: fixture.deploymentProof,
      browserWriteProof: fixture.browserWriteProof,
    })
    const eventLogCopy = backup.copied.find((file) => file.key === 'eventLog')
    await writeFile(eventLogCopy.destination, 'corrupted\n', 'utf8')

    const result = await verifyIndexerBackup({
      manifest: join(backup.outputDir, 'manifest.json'),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'file_eventLog_checksum')).toMatchObject({
      ok: false,
    })
  })
})

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-names-indexer-backup-'))
  tempDirs.push(dir)
  return dir
}

async function writeBackupFixture(dir) {
  const files = {
    eventLog: join(dir, 'events.jsonl'),
    cursor: join(dir, 'cursor.json'),
    checkpoint: join(dir, 'checkpoint.json'),
    envFile: join(dir, '.env.production'),
    deploymentProof: join(dir, 'proof.json'),
    browserWriteProof: join(dir, 'browser-proof.json'),
    sqliteDb: join(dir, 'indexer.sqlite'),
    sqliteWal: join(dir, 'indexer.sqlite-wal'),
    sqliteShm: join(dir, 'indexer.sqlite-shm'),
  }
  await Promise.all(Object.entries(files).map(([key, file]) => (
    writeFile(file, `${key}\n`, 'utf8')
  )))
  return files
}
