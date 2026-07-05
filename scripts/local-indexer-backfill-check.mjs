#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadLocalIndexerStore } from '../server/local-indexer.mjs'

const defaultEventLog = 'target/dusk-domains-local-indexer.events.jsonl'
const defaultSnapshot = 'target/dusk-domains-local-indexer.json'
const defaultCursor = 'target/dusk-domains-local-indexer.cursor.json'
const defaultW3sperContractFile = 'node_modules/@dusk/w3sper/src/contract.js'

if (isCliEntry()) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(usage())
    } else {
      const result = await checkIndexerBackfillBoundary(args)
      printResult(result, args.json)
      if (!result.ok) process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error('')
    console.error(usage())
    process.exitCode = 1
  }
}

export async function checkIndexerBackfillBoundary(options = {}) {
  const eventLog = resolve(options.eventLog ?? defaultEventLog)
  const snapshot = resolve(options.snapshot ?? defaultSnapshot)
  const cursor = resolve(options.cursor ?? defaultCursor)
  const w3sperContractFile = resolve(options.w3sperContractFile ?? defaultW3sperContractFile)
  const exists = options.exists ?? existsSync
  const readText = options.readText ?? ((file) => readFile(file, 'utf8'))
  const loadStore = options.loadStore ?? loadLocalIndexerStore
  const defaultEventLogRequested = !options.eventLog || options.eventLog === defaultEventLog

  const eventLogStatus = await loadStoreStatus({
    source: { mode: 'event-log', file: eventLog, cursorFile: cursor },
    exists,
    loadStore,
  })
  const snapshotStatus = await loadStoreStatus({
    source: { mode: 'snapshot', file: snapshot },
    exists,
    loadStore,
  })
  const surface = await inspectW3sperEventSurface({
    file: w3sperContractFile,
    exists,
    readText,
  })
  const backfill = backfillBoundary(surface)
  const eventLogOk = eventLogStatus.ok
    || (defaultEventLogRequested && eventLogStatus.missing && snapshotStatus.ok)
  const checks = [
    {
      id: 'event_log_fallback',
      ok: eventLogOk,
      message: eventLogStatus.ok
        ? `Event-log fallback loads ${eventLogStatus.names} indexed name(s), ${eventLogStatus.checkpoint?.eventCount ?? 0} replayed event(s).`
        : eventLogOk
          ? `Default event-log fallback is missing, but snapshot fallback loads ${snapshotStatus.names} indexed name(s).`
        : eventLogStatus.message,
    },
    {
      id: 'snapshot_fallback',
      ok: snapshotStatus.ok,
      message: snapshotStatus.ok
        ? `Snapshot fallback loads ${snapshotStatus.names} indexed name(s).`
        : snapshotStatus.message,
    },
    {
      id: 'w3sper_live_event_surface',
      ok: surface.liveDecodedEvents,
      message: surface.liveDecodedEvents
        ? 'Installed W3sper Contract.events surface exposes decoded live on/once subscriptions.'
        : surface.message,
    },
  ]

  return {
    ok: checks.every((check) => check.ok),
    eventLog,
    snapshot,
    cursor,
    w3sperContractFile,
    checks,
    backfill,
    nextStep: backfill.status === 'blocked'
    ? 'Keep using npm run indexer:collect and snapshot/event-log fallback until Rusk/W3sper exposes a decoded historical contract-event range API.'
      : 'A candidate historical event surface exists; wire it into the local indexer before relying on it.',
  }
}

async function loadStoreStatus({ source, exists, loadStore }) {
  if (!exists(source.file)) {
    return {
      ok: false,
      missing: true,
      names: 0,
      checkpoint: null,
      message: `Missing ${source.mode} fallback file: ${source.file}. Generate a core/treasury indexer snapshot or event log first.`,
    }
  }

  try {
    const store = await loadStore(source)
    return {
      ok: store?.namesByCanonical instanceof Map && store.namesByCanonical.size > 0,
      missing: false,
      names: store?.namesByCanonical?.size ?? 0,
      checkpoint: store?.checkpoint ?? null,
      message: store?.namesByCanonical?.size > 0
        ? 'fallback loaded'
        : `${source.mode} fallback loaded but contains no active indexed names.`,
    }
  } catch (error) {
    return {
      ok: false,
      missing: false,
      names: 0,
      checkpoint: null,
      message: `${source.mode} fallback failed to load: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function inspectW3sperEventSurface({ file, exists = existsSync, readText = (path) => readFile(path, 'utf8') }) {
  if (!exists(file)) {
    return {
      liveDecodedEvents: false,
      historicalRangeEvents: false,
      message: `Missing W3sper contract facade source: ${file}`,
    }
  }

  const source = await readText(file)
  const liveDecodedEvents = /get\s+events\s*\(\)/.test(source)
    && /once\s*:\s*async/.test(source)
    && /on\s*:\s*\(\s*handler/.test(source)
    && /decodeEvent\s*\(/.test(source)
  const historicalRangeEvents = /from_?height|fromBlock|toBlock|range|history|replay/i.test(eventSurfaceSource(source))

  return {
    liveDecodedEvents,
    historicalRangeEvents,
    message: liveDecodedEvents
      ? 'W3sper live event surface detected.'
      : 'W3sper Contract.events live decoding surface was not detected.',
  }
}

function eventSurfaceSource(source) {
  const start = source.indexOf('get events()')
  if (start < 0) return ''
  const end = source.indexOf('\n  }\n}', start)
  return source.slice(start, end > start ? end : undefined)
}

function backfillBoundary(surface) {
  if (surface.historicalRangeEvents) {
    return {
      status: 'candidate',
      reason: 'The installed W3sper Contract.events surface appears to expose range/history terms; review and wire it before enabling historical backfill.',
    }
  }

  return {
    status: 'blocked',
    reason: 'The installed W3sper Contract.events facade exposes decoded live RUES on/once subscriptions, but no decoded historical contract-event range/backfill API. Local indexer history therefore depends on observed core/treasury events or npm run indexer:collect, with the snapshot fallback preserved.',
  }
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(result.ok ? 'indexer-backfill: fallback ready' : 'indexer-backfill: fallback not ready')
  for (const check of result.checks) {
    console.log(`${check.ok ? 'ok' : 'fail'} ${check.id}: ${check.message}`)
  }
  console.log(`historical backfill: ${result.backfill.status}`)
  console.log(result.backfill.reason)
  console.log(result.nextStep)
}

export function parseArgs(argv) {
  const parsed = {
    eventLog: defaultEventLog,
    snapshot: defaultSnapshot,
    cursor: defaultCursor,
    w3sperContractFile: defaultW3sperContractFile,
    json: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--json') parsed.json = true
    else if (arg === '--event-log') parsed.eventLog = requiredValue(argv, ++index, arg)
    else if (arg === '--snapshot') parsed.snapshot = requiredValue(argv, ++index, arg)
    else if (arg === '--cursor') parsed.cursor = requiredValue(argv, ++index, arg)
    else if (arg === '--w3sper-contract-file') parsed.w3sperContractFile = requiredValue(argv, ++index, arg)
    else throw new Error(`Unknown option: ${arg}`)
  }

  return parsed
}

function usage() {
  return `Check the local indexer historical-backfill boundary.

Usage:
  npm run check:indexer-backfill
  npm run check:indexer-backfill -- --json

Options:
  --event-log <file>              JSONL event log fallback. Default: ${defaultEventLog}.
  --snapshot <file>               Snapshot fallback. Default: ${defaultSnapshot}.
  --cursor <file>                 Collector cursor for the event log. Default: ${defaultCursor}.
  --w3sper-contract-file <file>   W3sper Contract facade source to audit. Default: ${defaultW3sperContractFile}.
  --json                          Print machine-readable output.
  --help                          Show this message.`
}

function requiredValue(argv, index, label) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`)
  return value
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
