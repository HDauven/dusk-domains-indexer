import { describe, expect, it } from 'vitest'
import { productionIndexerNextStep } from './production-next-step.mjs'

describe('production indexer next step', () => {
  it('passes when every durability check is ok', () => {
    expect(productionIndexerNextStep({
      checks: [
        check('event_log', true),
        check('strict_health', true),
      ],
    })).toBe('Production indexer durability gate passed.')
  })

  it('falls back to checkpoint and collector guidance for generic failures', () => {
    expect(productionIndexerNextStep({
      checks: [check('strict_health', false)],
    })).toBe('Rebuild the checkpoint, start the live collector, and rerun this check once cursor/checkpoint/finality health is safe.')
  })

  it('asks for deployment start height when archive retention has no start height', () => {
    const nextStep = productionIndexerNextStep({
      checks: [
        check('archive_snapshot_required_deployment_start_height', false),
        check('archive_snapshot_required_height', false),
        check('archive_snapshot_required_file', false),
      ],
    })

    expect(nextStep).toBe('Record deployment start height, archive snapshot height, and retained archive snapshot artifact, then rerun with --require-archive-snapshot.')
  })

  it('asks only for archive snapshot evidence when start height is known', () => {
    const nextStep = productionIndexerNextStep({
      checks: [
        check('archive_snapshot_required_deployment_start_height', true),
        check('archive_snapshot_height', false),
        check('archive_snapshot_file', false),
      ],
    })

    expect(nextStep).toBe('Record archive snapshot height and retained archive snapshot artifact, then rerun with --require-archive-snapshot.')
    expect(nextStep).not.toContain('Record deployment start height')
  })

  it('asks for live collector freshness when source timestamps are stale', () => {
    expect(productionIndexerNextStep({
      checks: [check('source_freshness', false)],
    })).toBe('Restart or refresh the live collector until cursor/checkpoint source timestamps are inside the configured freshness window.')
  })

  it('asks for backup restore evidence when backup checks fail', () => {
    expect(productionIndexerNextStep({
      checks: [check('backup_manifest_required', false)],
    })).toBe('Create and verify an indexer backup manifest with restore staging, then rerun with --require-backup --backup-manifest <manifest> --backup-restore-dir <dir>.')
  })

  it('asks for SQLite backup evidence when the SQLite backup gate fails', () => {
    expect(productionIndexerNextStep({
      checks: [check('backup_sqlite_backup_present', false)],
      requireSqliteBackup: true,
    })).toBe('Create and verify an indexer backup manifest with restore staging and SQLite DB evidence, then rerun with --require-backup --require-sqlite-backup --backup-manifest <manifest> --backup-restore-dir <dir>.')
  })

  it('asks for SQLite import evidence when SQLite checks fail', () => {
    expect(productionIndexerNextStep({
      checks: [check('sqlite_file', false)],
    })).toBe('Import the event journal into SQLite/WAL, verify strict SQLite health, and rerun with --sqlite <db> --require-sqlite.')
  })

  it('combines targeted next steps in operator order', () => {
    expect(productionIndexerNextStep({
      checks: [
        check('archive_snapshot_file', false),
        check('sqlite_file', false),
        check('source_freshness', false),
        check('backup_manifest_required', false),
      ],
    })).toBe([
      'Record archive snapshot height and retained archive snapshot artifact, then rerun with --require-archive-snapshot.',
      'Restart or refresh the live collector until cursor/checkpoint source timestamps are inside the configured freshness window.',
      'Create and verify an indexer backup manifest with restore staging, then rerun with --require-backup --backup-manifest <manifest> --backup-restore-dir <dir>.',
      'Import the event journal into SQLite/WAL, verify strict SQLite health, and rerun with --sqlite <db> --require-sqlite.',
    ].join(' '))
  })
})

function check(id, ok) {
  return { id, ok, message: id }
}
