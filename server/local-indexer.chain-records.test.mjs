import { commitJournal } from '../scripts/test-fixtures/committed-cursor.mjs'
import { createEventLog, rootNode, envelope, receipt, rootName, ref, bytes } from '../scripts/test-fixtures/frozen-events.mjs'
import { recordsDigest } from '@duskdomains/sdk/projection'
import { expect, it } from 'vitest'
import { loadEventLogStore } from './local-indexer.mjs'
import { createRecentChangeWarnings, validateResolverRecords } from './local-indexer/records.mjs'
import { expectJson, startServer, writeEventLog } from './local-indexer-test-helpers.mjs'

const addresses = [
  ['address.btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
  ['address.eth', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
  ['address.sol', 'So11111111111111111111111111111111111111112'],
  ['address.evm', '0x52908400098527886E0F7030069857D2E4169EE7'],
]

it('serves cross-chain records from the event log through record, history and resolution APIs', async () => {
  const node = rootNode
  const now = new Date().toISOString()
  const records = addresses.map(([key, value]) => ({ key, value, visibility: 'public', ttlSeconds: 300, updatedAt: now }))
  const rawRecords = records.map(r => ({ key: r.key, value: [...new TextEncoder().encode(r.value)], ttl_seconds: 300n, updated_at: 15n }))
  const digest = recordsDigest(rawRecords)
  const update = envelope(receipt(15, [[5, 'resolver_slot_written', { slot: { registry: bytes(4), node: rootName().key.node, epoch: 1n }, snapshot: { records: rawRecords, count: 4, digest } }],
    [4, 'slot_changed', { name: ref(rootName()), previous: rootName().records, current: { resolver: bytes(5), epoch: 1n, count: 4, digest }, reason: 'Mutation' }]]))
  update.meta.observedAt = now
  const events = [...createEventLog(), update]
  const file = await writeEventLog(events)
  const store = await loadEventLogStore(file, await commitJournal(file))
  const { baseUrl, close } = await startServer(store)
  try {
    expect(await expectJson(`${baseUrl}/records?node=${node}`)).toMatchObject([...records].sort((a, b) => a.key.localeCompare(b.key)))
    const resolved = await expectJson(`${baseUrl}/resolve?name=aurora.dusk`)
    expect(resolved).toMatchObject({ verificationStatus: 'forward_resolved', resolver: { health: 'ok' }, errors: [] })
    expect(resolved.records).toMatchObject(records)
    expect(resolved.warnings.filter(warning => warning.code === 'recent_high_risk_record_change' && warning.target.startsWith('address.'))).toHaveLength(4)
    for (const record of records) {
      expect(await expectJson(`${baseUrl}/record?node=${node}&key=${record.key}`)).toMatchObject(record)
      expect(await expectJson(`${baseUrl}/record-history?node=${node}&key=${record.key}`)).toMatchObject([
        { key: record.key, action: 'set', value: record.value },
      ])
    }
  } finally {
    await close()
  }
})

it.each([
  ['address.btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'],
  ['address.eth', '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
  ['address.sol', '1'.repeat(31)],
  ['address.evm', '0x1234'],
])('rejects invalid %s values during forward validation', (key, value) => {
  expect(validateResolverRecords([{ key, value }])).toMatchObject([{ code: 'invalid_record' }])
  expect(validateResolverRecords([{ key, value: addresses.find(([addressKey]) => addressKey === key)[1] }])).toEqual([])
})

it.each(['primary_name', 'primary_name_set', 'primary_name_cleared'])('keeps recent-change warnings for %s', eventType => {
  const now = new Date()
  expect(createRecentChangeWarnings([{ eventType, timestamp: now.toISOString() }], now)).toMatchObject([
    { code: 'recent_primary_name_change', eventType },
  ])
})
