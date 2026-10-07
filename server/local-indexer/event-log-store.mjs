import { guardCandidate } from './candidate-publication.mjs'
import { loadCommittedJournal, validateCommittedEntries } from './committed-publication.mjs'
import { newestEventTimestamp } from './activity.mjs'
import {
  createReplayCheckpoint,
  indexerDurabilityState,
  loadCursor,
  loadDurableCheckpoint,
} from './checkpoint.mjs'
import {
  dedupeEventLogEntries,
} from './event-log.mjs'
import { deploymentBindingFromEvents } from './deployment-binding.mjs'
import { createReplayState, applyReplayEvent, finalizeReplayState } from './frozen-view.mjs'
export { createReplayState, applyReplayEvent, finalizeReplayState } from './frozen-view.mjs'

export function loadEventLogStore(eventLogFile, cursorFile, options = {}) {
  return guardCandidate(options.publication ?? {}, { source: 'local-indexer-event-log', mode: 'event-log' },
    candidate => buildEventLogCandidate(eventLogFile, cursorFile, options, candidate))
}

export async function buildEventLogCandidate(eventLogFile, cursorFile, options, candidate) {
  candidate.step = 'load-cursor'
  const cursor = candidate.cursor = await loadCursor(cursorFile)
  const warnings = candidate.warnings
  candidate.validateCursor()
  candidate.step = 'read-prefix'
  const parsedLog = await loadCommittedJournal(eventLogFile, cursor, warnings)
  warnings.push(...parsedLog.warnings)
  validateCommittedEntries(parsedLog.entries, cursor, warnings)
  candidate.check()
  const events = dedupeEventLogEntries(parsedLog.entries)
  const now = new Date().toISOString()
  const state = replayEventLog(events, warnings, now, cursor.scannedBlockHeight, candidate)
  candidate.view = state
  candidate.step = 'build-views'
  const checkpoint = createReplayCheckpoint(events, parsedLog.entries.length, warnings, now)
  candidate.metadata.checkpoint = checkpoint
  const durableCheckpoint = await loadDurableCheckpoint(options.checkpointFile)
  const durability = indexerDurabilityState({
    cursor,
    checkpoint,
    durableCheckpoint,
    warnings,
    strictHealth: Boolean(options.strictHealth),
    maxLagBlocks: options.maxLagBlocks,
    eventLogFile,
    cursorFile,
    checkpointFile: options.checkpointFile,
  })
  return {
    generatedAt: newestEventTimestamp(events) ?? now,
    source: 'local-indexer-event-log',
    mode: 'event-log',
    warnings,
    events,
    deployment: deploymentBindingFromEvents(events),
    cursor,
    checkpoint,
    durableCheckpoint: durableCheckpoint?.ok ? durableCheckpoint.value : null,
    durability,
    ...(durability.ok ? {} : { health: {
      ok: false,
      code: durability.code,
      message: durability.message,
    } }),
  }
}

// Low-level replay also supports offline fixture projections. Store loaders must first
// validate the cursor and its complete prefix; warnings prevent publication on failure.
export function replayEventLog(events, warnings, now, chainHeight = null, candidate = null) {
  const state = createReplayState()
  // Parsing already proved this refresh incomplete; do not replay around the gap.
  state.blocked = warnings.length > 0
  if (candidate) candidate.step = 'replay'
  for (const entry of events) applyReplayEvent(state, entry, warnings)
  candidate?.check()
  if (candidate) candidate.step = 'finalize'
  return finalizeReplayState(state, now, chainHeight, warnings)
}
