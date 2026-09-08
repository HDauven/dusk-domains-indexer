#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain } from './is-main.mjs'
import { loadLocalIndexerStore } from '../server/local-indexer.mjs'
import { queryArchive } from './local-event-collector/archive.mjs'

const defaults = {
  eventLog: 'target/dusk-domains-local-indexer.events.jsonl',
  snapshot: 'target/dusk-domains-local-indexer.json',
  cursor: 'target/dusk-domains-local-indexer.cursor.json',
  nodeUrl: 'http://127.0.0.1:18180/',
}

if (isMain(import.meta)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) console.log(usage())
    else {
      const result = await checkIndexerBackfillBoundary(args)
      console.log(args.json ? JSON.stringify(result, null, 2) : result.checks.map(c => `${c.ok ? 'ok' : 'fail'} ${c.id}: ${c.message}`).join('\n'))
      if (!result.ok) process.exitCode = 1
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}

export async function checkIndexerBackfillBoundary(options = {}) {
  const eventLog = resolve(options.eventLog ?? defaults.eventLog)
  const snapshot = resolve(options.snapshot ?? defaults.snapshot)
  const cursor = resolve(options.cursor ?? defaults.cursor)
  const nodeUrl = options.nodeUrl ?? defaults.nodeUrl
  const exists = options.exists ?? existsSync
  const loadStore = options.loadStore ?? loadLocalIndexerStore
  const eventLogStatus = await loadStoreStatus({ source: { mode: 'event-log', file: eventLog, cursorFile: cursor }, exists, loadStore })
  const snapshotStatus = await loadStoreStatus({ source: { mode: 'snapshot', file: snapshot }, exists, loadStore })
  const eventLogOk = eventLogStatus.ok || ((!options.eventLog || options.eventLog === defaults.eventLog) && eventLogStatus.missing && snapshotStatus.ok)
  let backfill
  try {
    const query = text => queryArchive(nodeUrl, text, options.fetcher)
    const [height, hash] = (await query('{lastBlockPair{json}}')).lastBlockPair?.json?.last_finalized_block ?? []
    if (!Number.isSafeInteger(height) || height < 0 || !/^[0-9a-f]{64}$/.test(hash ?? '')) throw new Error('Invalid finalized head')
    const batch = (await query(`{contractEventBatch(hash:"${hash}"){blockHash complete json}}`)).contractEventBatch
    if (batch?.complete !== true || batch.blockHash !== hash || !Array.isArray(batch.json)) throw new Error('Finalized archive batch is unavailable or incomplete')
    backfill = { status: 'available', height, blockHash: hash,
      reason: 'Hash-bound archive batches are available. The collector replays finalized blocks with the deployed WASM decoders; W3sper live history APIs are not required.' }
  } catch (error) {
    backfill = { status: 'blocked', reason: error.message }
  }
  const checks = [
    { id: 'event_log_fallback', ok: eventLogOk, message: eventLogOk ? 'Event journal or default snapshot fallback loads.' : eventLogStatus.message },
    { id: 'snapshot_fallback', ok: snapshotStatus.ok, message: snapshotStatus.message },
    { id: 'archive_backfill', ok: backfill.status === 'available', message: backfill.reason },
  ]
  return { ok: checks.every(c => c.ok), eventLog, snapshot, cursor, nodeUrl, checks, backfill,
    nextStep: 'Run npm run indexer:collect against this archive. Legacy logs require new journal/cursor/SQLite paths. Availability at the head is not proof of retention back to deployment.' }
}

async function loadStoreStatus({ source, exists, loadStore }) {
  if (!exists(source.file)) return { ok: false, missing: true, message: `Missing ${source.mode} fallback file: ${source.file}` }
  try {
    const store = await loadStore(source)
    const names = store?.namesByCanonical?.size ?? 0
    return { ok: names > 0, message: `${source.mode} fallback loads ${names} indexed name(s).` }
  } catch (error) { return { ok: false, message: `${source.mode} fallback failed: ${error.message}` } }
}

export function parseArgs(argv) {
  const args = { ...defaults, json: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else {
      const key = { '--event-log': 'eventLog', '--snapshot': 'snapshot', '--cursor': 'cursor', '--node-url': 'nodeUrl',
        '--w3sper-contract-file': 'w3sperContractFile' }[arg]
      if (!key) throw new Error(`Unknown option: ${arg}`)
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      args[key] = value
    }
  }
  return args
}

function usage() {
  return `Check archive-backed recovery and existing local fallbacks.
Usage: npm run backfill:check -- --node-url http://127.0.0.1:18180/ --json
Options: --node-url <archive>, --event-log <jsonl>, --snapshot <json>, --cursor <json>, --json, --help.
--w3sper-contract-file is accepted for older launchers but no longer needed.`
}
