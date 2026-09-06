export function summarizeEventLogText(text) {
  const entries = parseEventLogEntries(text)
  const lastEntry = entries.at(-1)
  const meta = lastEntry?.meta ?? {}
  const event = lastEntry?.event ?? {}
  return {
    eventCount: entries.length,
    lastEventAt: meta.observedAt ?? event.updatedAt ?? event.createdAt ?? event.observedAt ?? null,
    lastContract: meta.contractKey ?? null,
    lastEventName: event.type ?? null,
    lastTxId: meta.txId ?? null,
    lastBlockHeight: meta.blockHeight ?? null,
    currentBlockHeight: meta.blockHeight ?? null,
    scannedBlockHeight: meta.blockHeight ?? null,
  }
}

function parseEventLogEntries(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed.filter(isEventLogEntry) : []
    } catch {
      return []
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(isEventLogEntry)
}

function isEventLogEntry(value) {
  return Boolean(value?.event?.type)
}
