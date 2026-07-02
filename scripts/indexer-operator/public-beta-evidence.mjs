import { existsSync, readFileSync } from 'node:fs'

export const publicBetaEvidenceDefaults = Object.freeze({
  archiveSnapshot: 'target/archive-snapshots/public-beta-devnet-archive-marker.json',
  backupManifest: 'target/indexer-backups/public-beta-devnet/manifest.json',
  backupRestoreDir: 'target/indexer-backups/restore-stage-public-beta-devnet',
})

export function readArchiveSnapshotMarker(file, {
  exists = existsSync,
  readText = (path) => readFileSync(path, 'utf8'),
} = {}) {
  if (!file || !exists(file)) return null
  try {
    return JSON.parse(readText(file))
  } catch {
    return null
  }
}
