import { describe, expect, it } from 'vitest'
import {
  checkIndexerBackfillBoundary,
  inspectW3sperEventSurface,
  parseArgs,
} from './local-indexer-backfill-check.mjs'

describe('local indexer backfill boundary check', () => {
  it('parses CLI options used by the runbook', () => {
    expect(parseArgs([
      '--event-log',
      'events.jsonl',
      '--snapshot',
      'snapshot.json',
      '--cursor',
      'cursor.json',
      '--w3sper-contract-file',
      'contract.js',
      '--json',
    ])).toEqual({
      eventLog: 'events.jsonl',
      snapshot: 'snapshot.json',
      cursor: 'cursor.json',
      w3sperContractFile: 'contract.js',
      json: true,
      help: false,
    })
  })

  it('reports loadable fallbacks and the current historical backfill blocker', async () => {
    const result = await checkIndexerBackfillBoundary({
      eventLog: 'target/events.jsonl',
      snapshot: 'target/snapshot.json',
      cursor: 'target/cursor.json',
      w3sperContractFile: 'node_modules/@dusk/w3sper/src/contract.js',
      exists: () => true,
      readText: async () => liveOnlyW3sperContractSource(),
      loadStore: async (source) => ({
        mode: source.mode,
        namesByCanonical: new Map([['aurora.dusk', {}]]),
        checkpoint: source.mode === 'event-log' ? { eventCount: 7 } : null,
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.checks.map((check) => [check.id, check.ok])).toEqual([
      ['event_log_fallback', true],
      ['snapshot_fallback', true],
      ['w3sper_live_event_surface', true],
    ])
    expect(result.backfill).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('no decoded historical contract-event range/backfill API'),
    })
    expect(result.nextStep).toContain('snapshot/event-log fallback')
  })

  it('keeps the default snapshot fallback ready when the event log is missing', async () => {
    const result = await checkIndexerBackfillBoundary({
      snapshot: 'target/snapshot.json',
      w3sperContractFile: 'node_modules/@dusk/w3sper/src/contract.js',
      exists: (file) => !String(file).endsWith('dusk-domains-local-indexer.events.jsonl'),
      readText: async () => liveOnlyW3sperContractSource(),
      loadStore: async () => ({
        namesByCanonical: new Map([['aurora.dusk', {}]]),
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.checks.find((check) => check.id === 'event_log_fallback')).toMatchObject({
      ok: true,
      message: expect.stringContaining('snapshot fallback loads 1 indexed name'),
    })
  })

  it('fails when an explicit custom event-log fallback is missing', async () => {
    const result = await checkIndexerBackfillBoundary({
      eventLog: 'target/missing-events.jsonl',
      snapshot: 'target/snapshot.json',
      w3sperContractFile: 'node_modules/@dusk/w3sper/src/contract.js',
      exists: (file) => !String(file).includes('missing-events'),
      readText: async () => liveOnlyW3sperContractSource(),
      loadStore: async () => ({
        namesByCanonical: new Map([['aurora.dusk', {}]]),
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'event_log_fallback')).toMatchObject({
      ok: false,
      message: expect.stringContaining('Generate a core/treasury indexer snapshot or event log first'),
    })
  })

  it('detects a candidate historical event surface if W3sper adds range terms under Contract.events', async () => {
    const surface = await inspectW3sperEventSurface({
      file: 'contract.js',
      exists: () => true,
      readText: async () => liveOnlyW3sperContractSource('history: (fromHeight, toHeight) => [],'),
    })

    expect(surface).toMatchObject({
      liveDecodedEvents: true,
      historicalRangeEvents: true,
    })
  })
})

function liveOnlyW3sperContractSource(extraSurface = '') {
  return `
    export class Contract {
      get events() {
        const apiFor = (name) => ({
          once: async () => {
            const driver = await this.#driverPromise;
            return driver.decodeEvent(name, new Uint8Array());
          },
          on: (handler) => {
            handler({});
          },
          ${extraSurface}
        });
        return new Proxy({}, {
          get: (_t, prop) => apiFor(String(prop)),
        });
      }
    }
  `
}
