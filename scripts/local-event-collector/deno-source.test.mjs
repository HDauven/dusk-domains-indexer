import { describe, expect, it } from 'vitest'
import { denoCollectorSource } from './deno-source.mjs'

describe('local event collector Deno source', () => {
  it('embeds runtime constants used by lifecycle event normalization', () => {
    const source = denoCollectorSource()

    expect(source).toContain('import { normalizeObservedEvent } from "./event-decoder.mjs";')
    expect(source).toContain('const targetBlockSeconds = 10;')
    expect(source).toContain('const blockHeightPollMs = 5000;')
    expect(source).toContain('normalizeObservedEvent({ contract, eventName, event, observedAt, targetBlockSeconds })')
    expect(source).toContain('scannedBlockHeight: currentBlockHeight')
    expect(source).toContain('}, blockHeightPollMs);')
  })

  it('can point the generated Deno collector at an operator decoder module URL', () => {
    expect(denoCollectorSource({
      decoderUrl: 'file:///repo/scripts/indexer-operator/event-decoder.mjs',
    })).toContain('import { normalizeObservedEvent } from "file:///repo/scripts/indexer-operator/event-decoder.mjs";')
  })

  it('polls block height before subscriptions can append events and stamps fallback heights', () => {
    const source = denoCollectorSource()

    expect(source.indexOf('await refreshBlockHeight();')).toBeLessThan(source.indexOf('for (const contract of contracts)'))
    expect(source).toContain('normalized.meta.blockHeight = currentBlockHeight;')
  })
})
