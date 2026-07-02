import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  dedupeEventLogEntries,
  eventTimestamp,
  parseEventLog,
} from '../event-log.mjs'

export async function loadDurableCheckpoint(checkpointFile) {
  if (!checkpointFile) return { ok: false, status: 'not_configured', value: null, message: 'No checkpoint file configured.' }
  if (!existsSync(checkpointFile)) {
    return {
      ok: false,
      status: 'missing',
      value: null,
      message: `Missing checkpoint file: ${checkpointFile}`,
    }
  }

  try {
    const parsed = JSON.parse(await readFile(checkpointFile, 'utf8'))
    return {
      ok: true,
      status: 'ready',
      value: normalizeDurableCheckpoint(parsed),
      message: 'checkpoint loaded',
    }
  } catch (error) {
    return {
      ok: false,
      status: 'unreadable',
      value: null,
      message: `Could not read checkpoint file: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function createEventLogReplayCheckpoint(eventLogFile, updatedAt = new Date().toISOString()) {
  const parsedLog = parseEventLog(await readFile(eventLogFile, 'utf8'))
  const events = dedupeEventLogEntries(parsedLog.entries)
  const checkpoint = createReplayCheckpoint(events, parsedLog.entries.length, parsedLog.warnings, updatedAt)
  return {
    checkpoint,
    warnings: parsedLog.warnings,
    rawEventCount: parsedLog.entries.length,
    eventCount: events.length,
  }
}

export async function writeIndexerCheckpointFile(checkpointFile, checkpoint) {
  await mkdir(dirname(checkpointFile), { recursive: true })
  const tempFile = `${checkpointFile}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tempFile, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
  await rename(tempFile, checkpointFile)
}

export function createReplayCheckpoint(events, rawEventCount, warnings, updatedAt) {
  let last = null

  for (const entry of events) {
    const event = entry?.event ?? entry
    if (event?.type) last = { event, meta: entry?.meta ?? {} }
  }

  return {
    version: 1,
    source: 'local-indexer-event-log',
    status: 'replayed',
    eventCount: events.length,
    rawEventCount,
    duplicateCount: Math.max(0, rawEventCount - events.length),
    warningCount: warnings.length,
    updatedAt,
    lastEventAt: last ? eventTimestamp(last.event, last.meta) : null,
    lastContract: last?.meta?.contractKey ?? null,
    lastEventName: last?.event?.type ?? null,
    lastTxId: last?.meta?.txId ?? null,
    lastBlockHeight: last?.meta?.blockHeight ?? null,
  }
}

function normalizeDurableCheckpoint(parsed) {
  return {
    version: parsed.version ?? 1,
    source: parsed.source ?? 'local-indexer-event-log',
    status: parsed.status ?? 'replayed',
    eventCount: Number.isFinite(Number(parsed.eventCount)) ? Number(parsed.eventCount) : 0,
    rawEventCount: Number.isFinite(Number(parsed.rawEventCount)) ? Number(parsed.rawEventCount) : 0,
    duplicateCount: Number.isFinite(Number(parsed.duplicateCount)) ? Number(parsed.duplicateCount) : 0,
    warningCount: Number.isFinite(Number(parsed.warningCount)) ? Number(parsed.warningCount) : 0,
    updatedAt: parsed.updatedAt ?? null,
    lastEventAt: parsed.lastEventAt ?? null,
    lastContract: parsed.lastContract ?? null,
    lastEventName: parsed.lastEventName ?? null,
    lastTxId: parsed.lastTxId ?? null,
    lastBlockHeight: parsed.lastBlockHeight ?? null,
  }
}
