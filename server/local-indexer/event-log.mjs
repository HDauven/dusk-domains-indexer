export function parseEventLog(text) {
  const trimmed = text.trim()
  if (!trimmed) return { entries: [], warnings: [] }
  if (trimmed.startsWith('[')) {
    try {
      const entries = JSON.parse(trimmed)
      if (Array.isArray(entries)) {
        const warnings = []
        const valid = entries.filter((entry, index) => {
          const warning = eventLogEntryWarning(entry, index + 1)
          if (warning) warnings.push(warning)
          return !warning
        })
        return { entries: valid, warnings }
      }
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
      const entry = JSON.parse(line)
      const warning = eventLogEntryWarning(entry, index + 1)
      if (warning) warnings.push(warning)
      else entries.push(entry)
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

const textMetadata = ['eventId', 'txId', 'blockHash', 'chainId', 'source', 'timeSource', 'contractKey', 'contractId', 'observedAt']
const integerMetadata = ['blockHeight', 'observedBlockHeight', 'eventIndex']
const eventTimestampFields = ['updatedAt', 'createdAt', 'observedAt']

/** Validate journal metadata before a storage backend can replay or bind it. */
export function eventLogEntryWarning(entry, line) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {
    code: 'invalid_event_log_envelope', line, message: 'Event log row must be an object.',
  }
  const meta = entry.meta ?? {}
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {
    code: 'invalid_event_log_metadata', line, message: 'Event log metadata must be an object.',
  }
  const invalidText = textMetadata.find(field => Object.hasOwn(meta, field)
    && meta[field] !== null && typeof meta[field] !== 'string')
  const invalidInteger = integerMetadata.find(field => Object.hasOwn(meta, field)
    && meta[field] !== null && (!Number.isSafeInteger(meta[field]) || meta[field] < 0))
  const event = entry.event ?? entry
  const invalidTimestamp = event && typeof event === 'object' && !Array.isArray(event)
    ? eventTimestampFields.find(field => Object.hasOwn(event, field)
      && event[field] !== null && typeof event[field] !== 'string')
    : null
  const field = invalidText ?? invalidInteger ?? invalidTimestamp
  return field ? {
    code: 'invalid_event_log_metadata', line,
    message: `Event log ${invalidTimestamp === field ? 'timestamp' : 'metadata'} field ${field} has an invalid type or value.`,
  } : null
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
  return meta?.observedAt ?? event?.updatedAt ?? event?.createdAt ?? event?.observedAt ?? null
}

export function confirmedEventBlockHeight(event, meta = {}) {
  if (meta?.source !== 'w3sper-live-subscription' || Object.hasOwn(meta, 'observedBlockHeight')) return meta?.blockHeight ?? null
  // Older live logs substituted a polled height. Recover only heights in event payloads.
  if (event?.type === 'registration_committed') return meta.blockHeight ?? null
  return [
    'createdAtBlockHeight', 'updatedAtBlockHeight', 'openedAtBlockHeight', 'closedAtBlockHeight',
    'filledAtBlockHeight', 'placedAtBlockHeight', 'cancelledAtBlockHeight', 'settledAtBlockHeight',
    'acceptedAtBlockHeight', 'claimedAtBlockHeight',
  ].map(key => event?.[key]).find(value => value != null) ?? event?.record?.updatedAtBlockHeight ?? null
}

export function eventLogEntryKey(entry) {
  const event = entry?.event ?? entry
  const meta = entry?.meta ?? {}
  return stableJson({
    event,
    meta: {
      ...(meta.eventId ? { eventId: meta.eventId } : {}),
      txId: meta.txId ?? null,
      blockHeight: meta.blockHeight ?? null,
      contractKey: meta.contractKey ?? null,
      contractId: meta.contractId ?? null,
    },
  })
}
