import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { numberOrNull } from '../http.mjs'

export function normalizeSnapshotBlockCursor(value) {
  if (!value || typeof value !== 'object') return null
  const currentBlockHeight = numberOrNull(value.currentBlockHeight)
  const lastBlockHeight = numberOrNull(value.lastBlockHeight)
  const scannedBlockHeight = numberOrNull(value.scannedBlockHeight)
  if (currentBlockHeight === null && lastBlockHeight === null && scannedBlockHeight === null) return null
  return {
    ...(currentBlockHeight === null ? {} : { currentBlockHeight }),
    ...(lastBlockHeight === null ? {} : { lastBlockHeight }),
    ...(scannedBlockHeight === null ? {} : { scannedBlockHeight }),
  }
}

export async function loadCursor(cursorFile) {
  if (!cursorFile || !existsSync(cursorFile)) return null

  try {
    const parsed = JSON.parse(await readFile(cursorFile, 'utf8'))
    return normalizeCursor(parsed)
  } catch (error) {
    return {
      version: 1,
      source: 'local-indexer-cursor',
      status: 'unreadable',
      eventCount: 0,
      replayedEventCount: 0,
      startedAt: null,
      updatedAt: null,
      lastEventAt: null,
      lastContract: null,
      lastEventName: null,
      lastTxId: null,
      lastBlockHeight: null,
      currentBlockHeight: null,
      scannedBlockHeight: null,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function normalizeCursor(parsed) {
  return {
    version: parsed.version ?? 1,
    source: parsed.source ?? 'unknown',
    status: parsed.status ?? 'unknown',
    eventCount: Number.isFinite(Number(parsed.eventCount)) ? Number(parsed.eventCount) : 0,
    replayedEventCount: Number.isFinite(Number(parsed.replayedEventCount)) ? Number(parsed.replayedEventCount) : 0,
    startedAt: parsed.startedAt ?? null,
    updatedAt: parsed.updatedAt ?? null,
    lastEventAt: parsed.lastEventAt ?? null,
    lastContract: parsed.lastContract ?? null,
    lastEventName: parsed.lastEventName ?? null,
    lastTxId: parsed.lastTxId ?? null,
    lastBlockHeight: parsed.lastBlockHeight ?? null,
    currentBlockHeight: parsed.currentBlockHeight ?? parsed.lastBlockHeight ?? null,
    scannedBlockHeight: parsed.scannedBlockHeight ?? parsed.currentBlockHeight ?? parsed.lastBlockHeight ?? null,
    reason: parsed.reason ?? null,
  }
}
