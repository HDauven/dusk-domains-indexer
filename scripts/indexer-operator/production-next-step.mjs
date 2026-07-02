export function productionIndexerNextStep({ checks, requireSqliteBackup = false }) {
  if (checks.every((check) => check.ok)) return 'Production indexer durability gate passed.'

  const failedIds = checks.filter((check) => !check.ok).map((check) => check.id)
  const archiveInputsMissing = failedIds.some((id) => id.startsWith('archive_snapshot_required_'))
  const archiveStartHeightMissing = failedIds.includes('archive_snapshot_required_deployment_start_height')
  const archiveEvidenceMissing = archiveInputsMissing || failedIds.some((id) => [
    'archive_snapshot_height_configured',
    'archive_snapshot_height',
    'archive_snapshot_file',
  ].includes(id))
  const sourceFreshnessFailed = failedIds.includes('source_freshness')
  const backupEvidenceFailed = failedIds.some((id) => id.startsWith('backup_'))
  const sqliteEvidenceFailed = failedIds.some((id) => id.startsWith('sqlite_'))

  const archiveNextStep = archiveStartHeightMissing
    ? 'Record deployment start height, archive snapshot height, and retained archive snapshot artifact, then rerun with --require-archive-snapshot.'
    : 'Record archive snapshot height and retained archive snapshot artifact, then rerun with --require-archive-snapshot.'
  const sourceFreshnessNextStep = 'Restart or refresh the live collector until cursor/checkpoint source timestamps are inside the configured freshness window.'
  const backupNextStep = requireSqliteBackup
    ? 'Create and verify an indexer backup manifest with restore staging and SQLite DB evidence, then rerun with --require-backup --require-sqlite-backup --backup-manifest <manifest> --backup-restore-dir <dir>.'
    : 'Create and verify an indexer backup manifest with restore staging, then rerun with --require-backup --backup-manifest <manifest> --backup-restore-dir <dir>.'
  const sqliteNextStep = 'Import the event journal into SQLite/WAL, verify strict SQLite health, and rerun with --sqlite <db> --require-sqlite.'

  const targetedNextSteps = [
    archiveEvidenceMissing ? archiveNextStep : '',
    sourceFreshnessFailed ? sourceFreshnessNextStep : '',
    backupEvidenceFailed ? backupNextStep : '',
    sqliteEvidenceFailed ? sqliteNextStep : '',
  ].filter(Boolean)

  return targetedNextSteps.length > 0
    ? targetedNextSteps.join(' ')
    : 'Rebuild the checkpoint, start the live collector, and rerun this check once cursor/checkpoint/finality health is safe.'
}
