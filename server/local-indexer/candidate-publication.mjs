import assert from 'node:assert/strict'
import { emptyFrozenView } from './frozen-view.mjs'
import { committedCursor, publicationReady } from './committed-publication.mjs'

// The only owner of serving publications and reload caches. Builders mutate a
// private candidate; nothing is adopted until every stage (including metadata,
// persistence and stable-input checks) completes. Rejection never runs replay.
export async function guardCandidate(publication, metadata, build) {
  const candidate = {
    step: 'load-cursor', cursor: null, warnings: [], view: null, metadata: {}, signature: null,
    check() { if (this.warnings.length) throw new Error(this.warnings[0].message) },
    validateCursor() {
      this.step = 'validate-cursor'
      committedCursor(this.cursor, this.warnings)
      this.check()
      publicationReady({ lastCompleteView: publication.view }, this.cursor.scannedBlockHeight, this.warnings)
      this.check()
    },
  }
  try {
    const built = await build(candidate)
    candidate.check()
    if (candidate.reuse) return publication.store
    assert(candidate.view && !candidate.view.unavailable, 'Candidate did not produce a complete view.')
    assert.equal(candidate.view.projectionBlockHeight, candidate.cursor.scannedBlockHeight, 'Candidate clock differs from its cursor.')
    const store = { ...built, ...candidate.view }
    publication.view = candidate.view
    publication.signature = candidate.signature
    publication.store = store
    return store
  } catch (error) {
    const failure = { code: 'publication_candidate_rejected', step: candidate.step,
      error: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error) }
    publication.signature = null
    publication.store = {
      ...metadata, ...candidate.metadata, cursor: candidate.cursor,
      ...(publication.view ?? { ...emptyFrozenView(), unavailable: true }),
      warnings: [...candidate.warnings, failure], health: { ok: false, ...failure },
    }
    return publication.store
  }
}
