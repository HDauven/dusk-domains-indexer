import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

export const installedWalletSmokeSource = 'installed-wallet-provider-smoke'

export async function createSanitizedEventLogFixture(source, {
  blockedSources = [installedWalletSmokeSource],
  force = false,
  fs = { mkdtemp, readFile, writeFile },
  tempRoot = tmpdir(),
  prefix = 'dusk-domains-sanitized-event-log-',
} = {}) {
  if (source.mode !== 'event-log') {
    throw new Error('Sanitized event-log fixture requires event-log mode.')
  }

  const content = await fs.readFile(source.file, 'utf8')
  const blocked = new Set(blockedSources)
  let removedRows = 0
  const filteredLines = content.split(/\r?\n/u).filter((line) => {
    if (!line.trim()) return false
    try {
      const parsed = JSON.parse(line)
      if (blocked.has(parsed?.meta?.source)) {
        removedRows += 1
        return false
      }
      return true
    } catch {
      return true
    }
  })

  if (!force && removedRows === 0) {
    return {
      ...source,
      sanitized: false,
      removedRows,
    }
  }

  const fixtureDir = await fs.mkdtemp(resolve(tempRoot, prefix))
  const file = resolve(fixtureDir, 'events.jsonl')
  const cursorFile = resolve(fixtureDir, 'cursor.json')
  await fs.writeFile(file, `${filteredLines.join('\n')}${filteredLines.length ? '\n' : ''}`, 'utf8')
  await fs.writeFile(cursorFile, `${JSON.stringify({
    version: 1,
    source: 'sanitized-event-log',
    status: 'ready',
    eventCount: filteredLines.length,
    replayedEventCount: filteredLines.length,
    startedAt: null,
    updatedAt: null,
    lastEventAt: null,
    lastContract: null,
    lastEventName: null,
    lastTxId: null,
    lastBlockHeight: null,
    currentBlockHeight: null,
    reason: removedRows > 0 ? `Removed ${removedRows} synthetic installed-wallet smoke row(s).` : null,
  }, null, 2)}\n`, 'utf8')

  return {
    mode: 'event-log',
    file,
    cursorFile,
    fixtureDir,
    sourceFile: source.file,
    sanitized: removedRows > 0,
    removedRows,
  }
}
