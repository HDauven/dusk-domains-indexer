import { describe, expect, it } from 'vitest'
import { checkIndexerBackfillBoundary, parseArgs } from './local-indexer-backfill-check.mjs'

const hash = '11'.repeat(32)
const fixture = {
  exists: () => true,
  loadStore: async () => ({ namesByCanonical: new Map([['aurora.dusk', {}]]) }),
  fetcher: async (_url, { body }) => ({ ok: true, json: async () => body.includes('lastBlockPair')
    ? { lastBlockPair: { json: { last_finalized_block: [100, hash] } } }
    : { contractEventBatch: { complete: true, blockHash: hash, json: [] } } }),
}

describe('archive backfill check', () => {
  it('parses existing paths and the archive URL without requiring W3sper source', () => {
    expect(parseArgs(['--node-url', 'http://node/', '--event-log', 'events', '--json'])).toMatchObject({
      nodeUrl: 'http://node/', eventLog: 'events', json: true,
    })
    expect(() => parseArgs(['--node-url'])).toThrow()
  })

  it('accepts a complete zero-event archive batch, not a regex over the live facade', async () => {
    expect(await checkIndexerBackfillBoundary(fixture)).toMatchObject({
      ok: true, backfill: { status: 'available', height: 100, blockHash: hash },
    })
  })

  it('fails closed when an archive is missing, incomplete or returns the wrong block', async () => {
    for (const batch of [null, { complete: false, blockHash: hash, json: [] }, { complete: true, blockHash: '22'.repeat(32), json: [] }]) {
      const fetcher = async (url, options) => options.body.includes('lastBlockPair')
        ? fixture.fetcher(url, options) : { ok: true, json: async () => ({ contractEventBatch: batch }) }
      expect(await checkIndexerBackfillBoundary({ ...fixture, fetcher })).toMatchObject({ ok: false, backfill: { status: 'blocked' } })
    }
    expect(await checkIndexerBackfillBoundary({ ...fixture, fetcher: async () => { throw new Error('Archive offline') } }))
      .toMatchObject({ ok: false, backfill: { status: 'blocked', reason: 'Archive offline' } })
  })

  it('preserves default snapshot fallback but rejects a missing explicit journal', async () => {
    expect((await checkIndexerBackfillBoundary({ ...fixture,
      exists: path => !path.endsWith('dusk-domains-local-indexer.events.jsonl'),
    })).ok).toBe(true)
    expect((await checkIndexerBackfillBoundary({ ...fixture, eventLog: 'missing-events',
      exists: path => !path.endsWith('missing-events'),
    })).ok).toBe(false)
  })
})
