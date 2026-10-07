import { open } from 'node:fs/promises'
import { parseEventLog } from './event-log.mjs'

// Publication invariant: project exactly the journal prefix covered by ONE cursor,
// at that cursor's finalized height. Read the cursor before opening the journal;
// appended bytes beyond eventLogBytes do not exist for this attempt. A missing,
// incomplete or regressing candidate retains the last complete publication (or
// serves 503 if none exists). The clock never decreases during a store's lifetime.
export function committedCursor(cursor, warnings) {
  const uint = value => Number.isSafeInteger(value) && value >= 0
  const schema = {
    version: value => value === 2,
    source: value => value === 'rusk-finalized-archive',
    status: value => ['running', 'catching-up', 'blocked', 'stopped'].includes(value),
    fromBlock: value => uint(value) && value > 0,
    scannedBlockHeight: uint,
    currentBlockHeight: uint,
    scannedBlockHash: value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    eventLogBytes: uint,
    eventCount: uint,
    updatedAt: value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  }
  const invalid = Object.entries(schema).filter(([field, valid]) => !cursor || !Object.hasOwn(cursor, field) || !valid(cursor[field])).map(([field]) => field)
  if (!invalid.length) {
    if (cursor.scannedBlockHeight < cursor.fromBlock - 1) invalid.push('fromBlock')
    if (cursor.currentBlockHeight < cursor.scannedBlockHeight) invalid.push('currentBlockHeight')
  }
  if (!invalid.length) return cursor
  warnings.push({ code: 'publication_cursor_unavailable', fields: invalid,
    message: `Invalid committed cursor fields: ${invalid.join(', ')}.` })
  return null
}

export async function readCommittedJournal(file, cursor, start = 0) {
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size < cursor.eventLogBytes) throw new Error('Journal is shorter than its committed cursor.')
    const bytes = Buffer.alloc(cursor.eventLogBytes - start)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset)
      if (!bytesRead) throw new Error('Committed journal prefix was truncated during the read.')
      offset += bytesRead
    }
    if (bytes.length && bytes.at(-1) !== 0x0a) throw new Error('Committed cursor does not end at a complete JSONL row.')
    return { bytes, stat }
  } finally { await handle.close() }
}

export async function loadCommittedJournal(file, cursor, warnings) {
  if (!committedCursor(cursor, warnings)) return { entries: [], warnings: [] }
  try {
    const { bytes } = await readCommittedJournal(file, cursor)
    return parseEventLog(bytes.toString('utf8'))
  } catch (error) {
    warnings.push({ code: 'publication_prefix_unavailable', message: error.message })
    return { entries: [], warnings: [] }
  }
}

export function validateCommittedEntries(entries, cursor, warnings, rawCount = entries.length) {
  if (!cursor) return
  if (rawCount !== cursor.eventCount || entries.some(entry => {
    const height = entry?.meta?.blockHeight
    return !Number.isSafeInteger(height) || height < 0 || height > cursor.scannedBlockHeight
  })) warnings.push({ code: 'publication_prefix_mismatch', message: 'Committed receipt count or height does not match the cursor.' })
}

export function publicationReady(state, height, warnings = []) {
  if (height == null || !Number.isSafeInteger(height) || height < 0) {
    warnings.push({ code: 'publication_cursor_unavailable', message: 'No finalized publication clock is available.' })
    return false
  }
  if (state.lastCompleteView && BigInt(height) < BigInt(state.lastCompleteView.projectionBlockHeight)) {
    warnings.push({ code: 'publication_clock_regression', message: 'Reconstruction would decrease the retained publication clock.' })
    return false
  }
  return !state.blocked
}
