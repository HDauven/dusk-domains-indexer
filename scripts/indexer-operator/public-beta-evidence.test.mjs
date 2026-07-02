import { describe, expect, it } from 'vitest'

import {
  publicBetaEvidenceDefaults,
  readArchiveSnapshotMarker,
} from './public-beta-evidence.mjs'

describe('public beta evidence helpers', () => {
  it('defines stable controlled-devnet evidence paths', () => {
    expect(publicBetaEvidenceDefaults).toEqual({
      archiveSnapshot: 'target/archive-snapshots/public-beta-devnet-archive-marker.json',
      backupManifest: 'target/indexer-backups/public-beta-devnet/manifest.json',
      backupRestoreDir: 'target/indexer-backups/restore-stage-public-beta-devnet',
    })
  })

  it('reads an archive snapshot marker when present', () => {
    const marker = readArchiveSnapshotMarker('marker.json', {
      exists: (file) => file === 'marker.json',
      readText: () => '{"archiveSnapshotHeight":259443}',
    })

    expect(marker).toEqual({ archiveSnapshotHeight: 259443 })
  })

  it('ignores missing or invalid archive markers', () => {
    expect(readArchiveSnapshotMarker('', { exists: () => true })).toBeNull()
    expect(readArchiveSnapshotMarker('missing.json', { exists: () => false })).toBeNull()
    expect(readArchiveSnapshotMarker('invalid.json', {
      exists: () => true,
      readText: () => '{',
    })).toBeNull()
  })
})
