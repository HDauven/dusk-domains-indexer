import { describe, expect, it } from 'vitest'
import { denoCollectorSource } from './deno-source.mjs'
import { summarizeEventLogText } from './config.mjs'

describe('local event collector Deno source', () => {
  it('imports the same cursor summarizer through an absolute URL from temporary scripts', async () => {
    const source = denoCollectorSource()
    const [, moduleUrl] = source.match(/import \{ summarizeEventLogText \} from ("[^"]+");/)
    expect(JSON.parse(moduleUrl)).toMatch(/^file:/)
    const cursor = await import(JSON.parse(moduleUrl))
    expect(cursor.summarizeEventLogText).toBe(summarizeEventLogText)
    expect(source).not.toContain('function summarizeEventLogText(')
    expect(source).toContain('if (error instanceof Deno.errors.NotFound) return summarizeEventLogText("");')
    expect(cursor.summarizeEventLogText('')).toEqual({
      eventCount: 0,
      lastEventAt: null,
      lastContract: null,
      lastEventName: null,
      lastTxId: null,
      lastBlockHeight: null,
      currentBlockHeight: null,
      scannedBlockHeight: null,
    })
  })

  it('embeds runtime constants used by lifecycle event normalization', () => {
    const source = denoCollectorSource()

    expect(source).toContain('import { normalizeObservedEvent } from "./event-decoder.mjs";')
    expect(source).toContain('const targetBlockSeconds = 10;')
    expect(source).toContain('const blockHeightPollMs = 5000;')
    expect(source).toContain('normalizeObservedEvent({ contract, eventName, event, observedAt, targetBlockSeconds, observedBlockHeight: currentBlockHeight })')
    expect(source).toContain('scannedBlockHeight: currentBlockHeight')
    expect(source).toContain('}, blockHeightPollMs);')
  })

  it('can point the generated Deno collector at an operator decoder module URL', () => {
    expect(denoCollectorSource({
      decoderUrl: 'file:///repo/scripts/indexer-operator/event-decoder.mjs',
    })).toContain('import { normalizeObservedEvent } from "file:///repo/scripts/indexer-operator/event-decoder.mjs";')
  })

  it('polls before subscribing without presenting estimates as event heights', () => {
    const source = denoCollectorSource()

    expect(source.indexOf('await refreshBlockHeight();')).toBeLessThan(source.indexOf('for (const contract of contracts)'))
    expect(source).not.toContain('normalized.meta.blockHeight = currentBlockHeight;')
    expect(source).toContain('normalized.meta.eventId = "log:" + eventCount;')
  })
})
