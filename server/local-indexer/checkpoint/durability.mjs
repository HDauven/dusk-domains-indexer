import { numberOrNull } from '../http.mjs'
import { stableJson } from '../event-log.mjs'

export function indexerDurabilityState({
  cursor,
  checkpoint,
  durableCheckpoint,
  warnings,
  strictHealth,
  maxLagBlocks,
  eventLogFile,
  cursorFile,
  checkpointFile,
}) {
  const maxLag = Number.isFinite(Number(maxLagBlocks)) ? Number(maxLagBlocks) : 12
  const checks = []
  const push = (id, ok, message) => checks.push({ id, ok, message })

  push('event_log_replay', true, `Event log replay produced ${checkpoint.eventCount} deduped event(s).`)
  push('replay_warnings', !strictHealth || warnings.length === 0, warnings.length === 0
    ? 'Event log replay had no warnings.'
    : `Event log replay had ${warnings.length} warning(s).`)

  if (!strictHealth && durableCheckpoint?.ok !== true) {
    push('durable_checkpoint', true, 'Durable checkpoint is not required outside strict-health mode.')
  } else {
    push('durable_checkpoint', durableCheckpoint?.ok === true, durableCheckpoint?.ok
      ? 'Persisted checkpoint is readable.'
      : durableCheckpoint?.message ?? 'Persisted checkpoint is missing.')
  }

  if (durableCheckpoint?.ok) {
    const comparison = compareReplayCheckpoint(durableCheckpoint.value, checkpoint)
    push('checkpoint_matches_event_log', comparison.ok, comparison.message)
  } else if (strictHealth) {
    push('checkpoint_matches_event_log', false, 'Cannot compare checkpoint because persisted checkpoint is unavailable.')
  }

  if (!strictHealth && !cursorFile) {
    push('collector_cursor', true, 'Collector cursor is not required outside strict-health mode.')
  } else {
    const cursorReadable = Boolean(cursor) && cursor.status !== 'unreadable'
    push('collector_cursor', !strictHealth || cursorReadable, cursor
      ? cursor.status === 'unreadable'
        ? `Collector cursor is unreadable: ${cursor.reason ?? 'unknown error'}`
        : 'Collector cursor is readable.'
      : 'Collector cursor is missing.')
  }

  if (cursor) {
    const cursorCoversReplay = Number(cursor.eventCount ?? 0) >= checkpoint.eventCount
    push('cursor_event_count', !strictHealth || cursorCoversReplay, cursorCoversReplay
      ? 'Collector cursor has observed at least the replayed event count.'
      : `Collector cursor event count ${cursor.eventCount ?? 0} is behind replayed event count ${checkpoint.eventCount}.`)

    const currentBlockHeight = numberOrNull(cursor.currentBlockHeight)
    const scannedBlockHeight = numberOrNull(cursor.scannedBlockHeight ?? cursor.currentBlockHeight)
    const replayBlockHeight = numberOrNull(checkpoint.lastBlockHeight ?? cursor.lastBlockHeight)
    const coveredBlockHeight = maxNumberOrNull(scannedBlockHeight, replayBlockHeight)
    const lagBlocks = currentBlockHeight !== null && coveredBlockHeight !== null
      ? Math.max(0, currentBlockHeight - coveredBlockHeight)
      : null
    push('finality_lag', !strictHealth || (lagBlocks !== null && lagBlocks <= maxLag), lagBlocks === null
      ? 'Collector lag is unknown because block height metadata is incomplete.'
      : `Collector lag is ${lagBlocks} block(s); max allowed is ${maxLag}.`)
  }

  const failed = checks.filter((check) => !check.ok)
  return {
    ok: failed.length === 0,
    code: failed.length === 0 ? 'durable_indexer_ready' : 'durable_indexer_unsafe',
    message: failed.length === 0
      ? 'Durable indexer state is safe for the selected policy.'
      : `Durable indexer state is unsafe: ${failed.map((check) => check.id).join(', ')}.`,
    strictHealth,
    maxLagBlocks: maxLag,
    eventLogFile: eventLogFile ?? null,
    cursorFile: cursorFile ?? null,
    checkpointFile: checkpointFile ?? null,
    checks,
  }
}

function compareReplayCheckpoint(persisted, replayed) {
  const fields = [
    'eventCount',
    'rawEventCount',
    'duplicateCount',
    'warningCount',
    'lastContract',
    'lastEventName',
    'lastTxId',
    'lastBlockHeight',
  ]
  const mismatched = fields.filter((field) => stableJson(persisted?.[field] ?? null) !== stableJson(replayed?.[field] ?? null))
  if (mismatched.length > 0) {
    return {
      ok: false,
      message: `Persisted checkpoint is stale or mismatched for: ${mismatched.join(', ')}.`,
    }
  }
  return { ok: true, message: 'Persisted checkpoint matches the current event log replay.' }
}

function maxNumberOrNull(...values) {
  const numbers = values
    .map((value) => numberOrNull(value))
    .filter((value) => value !== null)
  return numbers.length ? Math.max(...numbers) : null
}
