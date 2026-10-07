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

// Preserve the wire value exactly. Candidate validation owns its schema; parse
// and I/O failures propagate to the publication boundary with their original error.
export async function loadCursor(cursorFile) {
  if (!cursorFile) return null
  return JSON.parse(await readFile(cursorFile, 'utf8'))
}
