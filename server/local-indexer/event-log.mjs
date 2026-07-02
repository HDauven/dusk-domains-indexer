export function parseEventLog(text) {
  const trimmed = text.trim()
  if (!trimmed) return { entries: [], warnings: [] }
  if (trimmed.startsWith('[')) {
    try {
      const entries = JSON.parse(trimmed)
      if (Array.isArray(entries)) return { entries, warnings: [] }
      return {
        entries: [],
        warnings: [{
          code: 'invalid_event_log_array',
          message: 'Event log JSON array source did not contain an array.',
        }],
      }
    } catch (error) {
      return {
        entries: [],
        warnings: [{
          code: 'invalid_event_log_array',
          message: error instanceof Error ? error.message : String(error),
        }],
      }
    }
  }

  const entries = []
  const warnings = []
  const lines = text.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue

    try {
      entries.push(JSON.parse(line))
    } catch (error) {
      warnings.push({
        code: 'invalid_event_log_row',
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { entries, warnings }
}

export function dedupeEventLogEntries(entries) {
  const seen = new Set()
  const deduped = []

  for (const entry of entries) {
    const key = eventLogEntryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(entry)
  }

  return deduped
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function eventTimestamp(event, meta = {}) {
  return meta.observedAt
    ?? event?.updatedAt
    ?? event?.createdAt
    ?? event?.releasedAt
    ?? event?.observedAt
    ?? event?.revokedAt
    ?? event?.delegatedAt
    ?? event?.record?.updatedAt
    ?? null
}

export function eventLogEntryKey(entry) {
  const event = entry?.event ?? entry
  const meta = entry?.meta ?? {}
  return stableJson({
    event,
    meta: {
      txId: meta.txId ?? null,
      blockHeight: meta.blockHeight ?? null,
      contractKey: meta.contractKey ?? null,
      contractId: meta.contractId ?? null,
    },
  })
}
