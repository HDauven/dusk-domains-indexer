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
  const node = `0x${'ab'.repeat(32)}`
  const now = new Date().toISOString()
  const records = addresses.map(([key, value]) => ({ key, value, visibility: 'public', ttlSeconds: 300, updatedAt: now }))
  const events = [{ event: { type: 'name_registered', node, label: 'aurora', actor: 'owner', owner: 'owner',
    expiresAt: '2099-01-01T00:00:00.000Z', graceEndsAt: '2099-02-01T00:00:00.000Z' } },
  { event: { type: 'resolver_changed', node, actor: 'owner', resolver: 'registry' } },
  ...records.map(record => ({ event: { type: 'record_changed', node, controller: 'owner', record } }))]
  const store = await loadEventLogStore(await writeEventLog(events))
  const { baseUrl, close } = await startServer(store)
  try {
    expect(await expectJson(`${baseUrl}/records?node=${node}`)).toEqual([...records].sort((a, b) => a.key.localeCompare(b.key)))
    const resolved = await expectJson(`${baseUrl}/resolve?name=aurora.dusk`)
    expect(resolved).toMatchObject({ verificationStatus: 'forward_resolved', resolver: { health: 'ok' }, errors: [] })
    expect(resolved.records).toEqual(expect.arrayContaining(records))
    expect(resolved.warnings.filter(warning => warning.code === 'recent_high_risk_record_change')).toHaveLength(4)
    for (const record of records) {
      expect(await expectJson(`${baseUrl}/record?node=${node}&key=${record.key}`)).toEqual(record)
      expect(await expectJson(`${baseUrl}/record-history?node=${node}&key=${record.key}`)).toMatchObject([
        { key: record.key, action: 'set', record },
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
