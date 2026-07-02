#!/usr/bin/env node

import { isCliEntry, parseArgs } from './local-indexer/cli.mjs'
import { serveLocalIndexer, usage } from './local-indexer/server.mjs'

export { healthResponseForStore } from './local-indexer/health.mjs'
export { dedupeEventLogEntries } from './local-indexer/event-log.mjs'
export { listNames } from './local-indexer/read-models.mjs'
export { createLocalIndexerHandler } from './local-indexer/routes.mjs'
export { loadSnapshotStore } from './local-indexer/snapshot.mjs'
export {
  createReloadingLocalIndexerStore,
  createReloadingSnapshotStore,
  createStaticLocalIndexerStore,
  createStaticSnapshotStore,
  importEventLogToSqlite,
  loadEventLogStore,
  loadLocalIndexerStore,
  loadSqliteStore,
} from './local-indexer/stores.mjs'
export {
  createEventLogReplayCheckpoint,
  writeIndexerCheckpointFile,
} from './local-indexer/checkpoint.mjs'
export {
  serveLocalIndexer,
  sourceFromArgs,
  usage,
} from './local-indexer/server.mjs'

if (isCliEntry(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))

  try {
    if (args.help) {
      console.log(usage())
    } else {
      await serveLocalIndexer(args)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
