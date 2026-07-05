import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createLocalIndexerHandler } from './routes.mjs'
import {
  createReloadingLocalIndexerStore,
  createStaticLocalIndexerStore,
} from './stores.mjs'

export async function serveLocalIndexer(args) {
  const source = sourceFromArgs(args)
  const storeProvider = args.watch
    ? await createReloadingLocalIndexerStore(source)
    : await createStaticLocalIndexerStore(source)
  const server = createServer(createLocalIndexerHandler(storeProvider, {
    corsOrigin: args.corsOrigin,
  }))

  server.listen(args.port, args.host, () => {
    console.log(`Dusk Domains local indexer listening on http://${args.host}:${args.port}`)
    console.log(`${sourceLabel(source)}: ${source.file}${args.watch ? ' (watching)' : ''}`)
    if (source.mode === 'sqlite' && source.eventLogFile) {
      console.log(`Import event log: ${source.eventLogFile}`)
    }
  })

  return server
}

export function sourceFromArgs(args) {
  if (args.sqlite) {
    return {
      mode: 'sqlite',
      file: resolve(args.sqlite),
      eventLogFile: args.eventLog ? resolve(args.eventLog) : '',
      cursorFile: resolve(args.cursor || 'target/dusk-domains-local-indexer.cursor.json'),
      strictHealth: args.strictHealth,
      maxLagBlocks: args.maxLagBlocks,
    }
  }

  if (args.eventLog) {
    return {
      mode: 'event-log',
      file: resolve(args.eventLog),
      cursorFile: resolve(args.cursor || 'target/dusk-domains-local-indexer.cursor.json'),
      checkpointFile: resolve(args.checkpoint || 'target/dusk-domains-local-indexer.checkpoint.json'),
      strictHealth: args.strictHealth,
      maxLagBlocks: args.maxLagBlocks,
    }
  }

  return { mode: 'snapshot', file: resolve(args.snapshot) }
}

function sourceLabel(source) {
  if (source.mode === 'event-log') return 'Event log'
  if (source.mode === 'sqlite') return 'SQLite'
  return 'Snapshot'
}

export function usage() {
  return `Serve the local Dusk Domains indexer snapshot or event log.

Usage:
  npm run indexer:local
  npm run indexer:local -- --snapshot target/dusk-domains-local-indexer.json --port 8787
  npm run indexer:local -- --event-log target/dusk-domains-local-indexer.events.jsonl --port 8787
  npm run indexer:local -- --sqlite target/dusk-domains-local-indexer.sqlite --event-log target/dusk-domains-local-indexer.events.jsonl --port 8787
  npm run indexer:local -- --watch

Options:
  --snapshot <file>  Snapshot JSON written by npm run e2e:local. Default: target/dusk-domains-local-indexer.json.
  --event-log <file> Replay JSON/JSONL indexer events instead of a snapshot.
  --sqlite <file>    Serve from a SQLite/WAL event store. With --event-log, rebuild/import the DB before serving.
  --cursor <file>    Optional collector cursor JSON exposed on /health. Default with --event-log: target/dusk-domains-local-indexer.cursor.json.
  --checkpoint <file> Optional persisted replay checkpoint JSON exposed on /health. Default with --event-log: target/dusk-domains-local-indexer.checkpoint.json.
  --strict-health    Fail /health when cursor/checkpoint/finality state is missing, stale, or unsafe.
  --host <host>      Host to bind. Default: 127.0.0.1.
  --port <port>      Port to bind. Default: 8787.
  --cors-origin <origin> CORS Access-Control-Allow-Origin value. Default: DUSK_DOMAINS_INDEXER_CORS_ORIGIN or *.
  --watch            Reload the snapshot/event log on request when the file changes.
  --help             Show this message.
`
}
