import { writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkProductionIndexer,
  parseArgs,
} from './production-indexer-check.mjs'
import {
  cleanupProductionIndexerFixtures,
  writeDurableFixture,
} from './test-fixtures/production-indexer-check.mjs'

afterEach(async () => {
  await cleanupProductionIndexerFixtures()
})

describe('production indexer durability check', () => {
  it('parses operator CLI options', () => {
    expect(parseArgs([
      '--event-log',
      'events.jsonl',
      '--cursor',
      'cursor.json',
      '--checkpoint',
      'checkpoint.json',
      '--sqlite',
      'indexer.sqlite',
      '--env-file',
      '.env.production',
      '--proof-report',
      'proof.json',
      '--archive-snapshot',
      'archive-snapshot.tar.zst',
      '--backup-manifest',
      'backups/launch/manifest.json',
      '--backup-restore-dir',
      'restore',
      '--require-archive-snapshot',
      '--require-backup',
      '--require-sqlite-backup',
      '--require-sqlite',
      '--max-lag-blocks',
      '8',
      '--max-source-age-minutes',
      '15',
      '--deployment-start-height',
      '100',
      '--archive-snapshot-height',
      '90',
      '--derive-deployment-start-height',
      '--rebuild',
      '--json',
    ])).toEqual({
      eventLog: 'events.jsonl',
      cursor: 'cursor.json',
      checkpoint: 'checkpoint.json',
      sqlite: 'indexer.sqlite',
      envFile: '.env.production',
      proofReport: 'proof.json',
      archiveSnapshot: 'archive-snapshot.tar.zst',
      backupManifest: 'backups/launch/manifest.json',
      backupRestoreDir: 'restore',
      requireArchiveSnapshot: true,
      requireBackup: true,
      requireSqliteBackup: true,
      requireSqlite: true,
      deriveDeploymentStartHeight: true,
      maxLagBlocks: 8,
      maxSourceAgeMinutes: 15,
      deploymentStartHeight: 100,
      archiveSnapshotHeight: 90,
      rebuild: true,
      json: true,
      help: false,
    })
  })

  it('adds stable public-beta evidence defaults for strict CLI mode', () => {
    expect(parseArgs([
      '--require-archive-snapshot',
      '--require-backup',
      '--require-sqlite',
    ])).toMatchObject({
      archiveSnapshot: 'target/archive-snapshots/public-beta-devnet-archive-marker.json',
      backupManifest: 'target/indexer-backups/public-beta-devnet/manifest.json',
      backupRestoreDir: 'target/indexer-backups/restore-stage-public-beta-devnet',
      sqlite: 'target/dusk-names-devnet-indexer.sqlite',
      requireArchiveSnapshot: true,
      requireBackup: true,
      requireSqlite: true,
    })
  })

  it('leaves archive and backup evidence optional outside strict CLI mode', () => {
    expect(parseArgs([])).toMatchObject({
      archiveSnapshot: '',
      backupManifest: '',
      backupRestoreDir: '',
      sqlite: '',
      requireArchiveSnapshot: false,
      requireBackup: false,
      requireSqlite: false,
    })
  })

  it('rebuilds a checkpoint and passes strict durable health', async () => {
    const fixture = await writeDurableFixture()
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(result.rebuilt).toMatchObject({
      eventCount: 2,
      rawEventCount: 2,
      warningCount: 0,
    })
    expect(result.health).toMatchObject({
      ok: true,
      eventCount: 2,
      currentBlockHeight: 12,
      finalizedBlockHeight: 12,
      lagBlocks: 0,
      durability: {
        ok: true,
      },
    })
  })

  it('keeps legacy Dusk Names active contract env as compatibility aliases', async () => {
    const fixture = await writeDurableFixture({ legacyActiveEnv: true })
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(result.checks.find((check) => check.id === 'deployment_surface')).toMatchObject({
      ok: true,
    })
  })

  it('fails when event journal contract IDs do not match deployment evidence', async () => {
    const fixture = await writeDurableFixture({ treasuryContractId: `0x${'99'.repeat(32)}` })
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'event_journal_treasury_matches_deployment'))
      .toMatchObject({
        ok: false,
        message: expect.stringContaining('mismatch'),
      })
  })

  it('fails when event journal contains legacy split-contract keys', async () => {
    const fixture = await writeDurableFixture({ legacyRow: true })
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'event_journal_contract_keys'))
      .toMatchObject({
        ok: false,
        message: expect.stringContaining('legacy'),
      })
  })

  it('enforces deployment start and archive snapshot height policy when provided', async () => {
    const fixture = await writeDurableFixture({ blockHeight: 10 })
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      deploymentStartHeight: 11,
      archiveSnapshotHeight: 12,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'deployment_start_height')).toMatchObject({
      ok: false,
    })
    expect(result.checks.find((check) => check.id === 'archive_snapshot_height')).toMatchObject({
      ok: false,
    })
  })

  it('fails when the persisted checkpoint is missing', async () => {
    const fixture = await writeDurableFixture()
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'checkpoint')).toMatchObject({
      ok: false,
      message: expect.stringContaining('Run with --rebuild first'),
    })
    expect(result.checks.find((check) => check.id === 'strict_health')).toMatchObject({
      ok: false,
      message: expect.stringContaining('durable_checkpoint'),
    })
  })

  it('fails when the persisted checkpoint no longer matches the journal', async () => {
    const fixture = await writeDurableFixture()
    await writeFile(fixture.checkpoint, JSON.stringify({
      version: 1,
      source: 'local-indexer-event-log',
      status: 'replayed',
      eventCount: 99,
      rawEventCount: 99,
      duplicateCount: 0,
      warningCount: 0,
      lastEventName: 'name_registered',
      lastTxId: 'tx-register',
      lastBlockHeight: 10,
    }, null, 2), 'utf8')

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
    })

    expect(result.ok).toBe(false)
    expect(result.health.durability.checks.find((check) => check.id === 'checkpoint_matches_event_log'))
      .toMatchObject({
        ok: false,
        message: expect.stringContaining('eventCount'),
      })
  })

  it('fails when collector lag exceeds policy', async () => {
    const fixture = await writeDurableFixture({ currentBlockHeight: 40, scannedBlockHeight: 10 })
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      maxLagBlocks: 5,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.health.durability.checks.find((check) => check.id === 'finality_lag'))
      .toMatchObject({
        ok: false,
        message: expect.stringContaining('30 block'),
      })
  })

  it('keeps quiet-chain health safe when the collector has scanned recent blocks', async () => {
    const fixture = await writeDurableFixture({ currentBlockHeight: 40, scannedBlockHeight: 40 })
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      maxLagBlocks: 5,
      now: '2026-06-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(result.health).toMatchObject({
      currentBlockHeight: 40,
      finalizedBlockHeight: 40,
      lagBlocks: 0,
    })
    expect(result.health.durability.checks.find((check) => check.id === 'finality_lag'))
      .toMatchObject({
        ok: true,
        message: expect.stringContaining('0 block'),
      })
  })

  it('passes source freshness when cursor or checkpoint was updated recently', async () => {
    const fixture = await writeDurableFixture()
    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      maxSourceAgeMinutes: 10,
      now: '2026-06-22T00:05:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(result.maxSourceAgeMinutes).toBe(10)
    expect(result.checks.find((check) => check.id === 'source_freshness')).toMatchObject({
      ok: true,
      message: expect.stringContaining('4 minute'),
    })
  })

  it('fails source freshness when cursor and checkpoint are stale', async () => {
    const fixture = await writeDurableFixture()
    await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      rebuild: true,
      now: '2026-06-22T00:00:00.000Z',
    })

    const result = await checkProductionIndexer({
      eventLog: fixture.eventLog,
      cursor: fixture.cursor,
      checkpoint: fixture.checkpoint,
      envFile: fixture.envFile,
      proofReport: fixture.proofReport,
      maxSourceAgeMinutes: 10,
      now: '2026-06-22T00:30:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'source_freshness')).toMatchObject({
      ok: false,
      message: expect.stringContaining('29 minute'),
    })
    expect(result.nextStep).toContain('Restart or refresh the live collector')
  })
})
