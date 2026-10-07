import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { loadDataDriver, parseJson, wireValue, stringifyJson } from '@duskdomains/sdk'
import { indexerEventCatalog } from '@duskdomains/sdk/event-catalog'
import { encodeReceipt, decodeReceipt } from './receipt-codec.mjs'
const golden = parseJson(gunzipSync(readFileSync(new URL('../../scripts/test-fixtures/frozen/frozen-v1.json.gz', import.meta.url))).toString())
const market = parseJson(gunzipSync(readFileSync(new URL('../../scripts/test-fixtures/frozen/market-v1.json.gz', import.meta.url))).toString())
it.each(Object.entries(indexerEventCatalog))('round-trips the golden %s event through the durable receipt codec', (topic, spec) => {
  const candidate = Object.values(golden).find(row => row.type === spec.type) ?? market[`event:${topic}`]
  expect(candidate, topic).toBeDefined()
  const event = { emitter: 'aa'.repeat(32), topic, ordinal: 0, reverted: false, data: wireValue(spec.type, candidate.json) }
  const r = { id: 'golden', height: 1n, success: true, events: [event] }
  const restored = decodeReceipt(JSON.parse(JSON.stringify(encodeReceipt(r))))
  expect(wireValue(spec.type, restored.events[0].data)).toEqual(event.data)
})
it('decodes actual frozen store golden rkyv with the lossless WASM data driver', async () => {
  const driver = await loadDataDriver(gunzipSync(readFileSync(new URL('../../scripts/test-fixtures/frozen/store.wasm.gz', import.meta.url))))
  for (const [topic, spec] of Object.entries(indexerEventCatalog)) {
    if (!['store', '*'].includes(spec.role)) continue
    const g = Object.values(golden).find(row => row.type === spec.type)
    expect(wireValue(spec.type, driver.decodeEvent(topic, Buffer.from(g.rkyv, 'hex')))).toEqual(wireValue(spec.type, g.json))
  }
})
