import { stat } from 'node:fs/promises'
import { loadEventLogStore } from './event-log-store.mjs'
import { loadSnapshotStore } from './snapshot.mjs'
import { loadSqliteStore } from './sqlite-store.mjs'

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
  let cachedStore = await loadLocalIndexerStore(source)
  let cachedSignature = await sourceSignature(source)

  return async () => {
    const nextSignature = await sourceSignature(source)
    if (nextSignature !== cachedSignature) {
      cachedStore = await loadLocalIndexerStore(source)
      cachedSignature = await sourceSignature(source)
    }
    return cachedStore
  }
}

export async function loadLocalIndexerStore(source) {
  if (source?.mode === 'sqlite') {
    return loadSqliteStore(source.file, {
      eventLogFile: source.eventLogFile,
      cursorFile: source.cursorFile,
      strictHealth: source.strictHealth,
      maxLagBlocks: source.maxLagBlocks,
    })
  }
  if (source?.mode === 'event-log') {
    return loadEventLogStore(source.file, source.cursorFile, {
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
      return `${file}:${fileStat.mtimeNs}:${fileStat.size}`
    } catch {
      return `${file}:missing`
    }
  }))
  return stats.join('|')
}

function sourceFiles(source) {
  if (source?.mode === 'sqlite') {
    return [
      source.file,
      source.eventLogFile,
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
