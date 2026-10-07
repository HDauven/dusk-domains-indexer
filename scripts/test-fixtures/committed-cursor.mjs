import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Explicit collector commit for fixtures: appending alone must never publish data.
export async function commitJournal(eventLogFile, overrides = {}, cursorFile = join(dirname(eventLogFile), 'cursor.json')) {
  const bytes = await readFile(eventLogFile)
  const rows = bytes.toString().split('\n').filter(line => line.trim())
  const height = Math.max(0, ...rows.map(line => { try { return JSON.parse(line).meta?.blockHeight ?? 0 } catch { return 0 } }))
  const cursor = { version: 2, source: 'rusk-finalized-archive', status: 'running', fromBlock: 1,
    scannedBlockHash: 'ab'.repeat(32), eventLogBytes: bytes.length, eventCount: rows.length,
    scannedBlockHeight: height, currentBlockHeight: height, updatedAt: new Date().toISOString(), ...overrides }
  await writeFile(cursorFile, JSON.stringify(cursor))
  return cursorFile
}
