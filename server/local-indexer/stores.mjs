import { guardCandidate } from './candidate-publication.mjs'
import { stat } from 'node:fs/promises'
import { buildEventLogCandidate, loadEventLogStore } from './event-log-store.mjs'
import { loadSnapshotStore } from './snapshot.mjs'
import { buildSqliteCandidate, loadSqliteStore } from './sqlite-store.mjs'

export { loadEventLogStore } from './event-log-store.mjs'
export { importEventLogToSqlite, loadSqliteStore } from './sqlite-store.mjs'

export async function createStaticSnapshotStore(snapshotFile) {
  return createStaticLocalIndexerStore({ mode: 'snapshot', file: snapshotFile })
}

export async function createReloadingSnapshotStore(snapshotFile) {
  return createReloadingLocalIndexerStore({ mode: 'snapshot', file: snapshotFile })
}

export async function createStaticLocalIndexerStore(source) {
  const store = await loadLocalIndexerStore(source)
  return () => store
}

export async function createReloadingLocalIndexerStore(source) {
  // Snapshot mode has no receipt/cursor candidate, but still serializes reloads.
  const frozen = ['event-log', 'sqlite'].includes(source?.mode)
  const publication = {}
  let refreshing, snapshot, snapshotSignature
  const reloadSnapshot = async () => {
    const signature = await sourceSignature(source)
    if (!snapshot || signature !== snapshotSignature) {
      const loaded = await loadSnapshotStore(source?.file ?? source)
      snapshot = loaded
      snapshotSignature = signature === await sourceSignature(source) ? signature : null
    }
    return snapshot
  }
  const refresh = () => guardCandidate(publication, {
    source: source.mode === 'sqlite' ? 'local-indexer-sqlite' : 'local-indexer-event-log', mode: source.mode,
  }, async candidate => {
    for (let attempt = 0; attempt < 3; attempt++) {
      candidate.step = 'read-inputs'
      const signature = await sourceSignature(source)
      if (publication.store && signature === publication.signature) {
        candidate.reuse = true
        return publication.store
      }
      const store = source.mode === 'sqlite'
        ? await buildSqliteCandidate(source.file, source, candidate)
        : await buildEventLogCandidate(source.file, source.cursorFile, source, candidate)
      candidate.step = 'validate-inputs'
      if (signature !== await sourceSignature(source)) continue
      candidate.signature = signature
      return store
    }
    candidate.warnings.push({ code: 'publication_inputs_changed', message: 'Inputs changed during reconstruction; retrying.' })
    candidate.check()
  })
  const provider = () => {
    refreshing ??= (frozen ? refresh() : reloadSnapshot()).finally(() => { refreshing = null })
    return refreshing
  }
  await provider()
  return provider
}

export async function loadLocalIndexerStore(source, publication = null) {
  if (source?.mode === 'sqlite') {
    return loadSqliteStore(source.file, {
      publication,
      eventLogFile: source.eventLogFile,
      cursorFile: source.cursorFile,
      strictHealth: source.strictHealth,
      maxLagBlocks: source.maxLagBlocks,
    })
  }
  if (source?.mode === 'event-log') {
    return loadEventLogStore(source.file, source.cursorFile, {
      publication,
      checkpointFile: source.checkpointFile,
      strictHealth: source.strictHealth,
      maxLagBlocks: source.maxLagBlocks,
    })
  }
  return loadSnapshotStore(source?.file ?? source)
}

async function sourceSignature(source) {
  const files = sourceFiles(source).filter(Boolean)
  const stats = await Promise.all(files.map(async (file) => {
    try {
      const fileStat = await stat(file, { bigint: true })
      return `${file}:${fileStat.dev}:${fileStat.ino}:${fileStat.ctimeNs}:${fileStat.mtimeNs}:${fileStat.size}`
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return `${file}:missing`
    }
  }))
  return stats.join('|')
}

function sourceFiles(source) {
  if (source?.mode === 'sqlite') {
    return [
      // With a journal, SQLite is a derived output, not a reload input.
      ...(source.eventLogFile ? [source.eventLogFile] : [source.file, `${source.file}-wal`]),
      source.cursorFile,
    ]
  }
  if (source?.mode === 'event-log') {
    return [
      source.file,
      source.cursorFile,
      source.checkpointFile,
    ]
  }
  return [source?.file ?? source]
}
