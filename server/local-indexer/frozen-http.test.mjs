import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { wireValue, validateRecordInput } from '@duskdomains/sdk'
import { recordsDigest } from '@duskdomains/sdk/projection'
import { afterEach, expect, it } from 'vitest'
import { loadEventLogStore, loadSqliteStore } from '../local-indexer.mjs'
import { startServer, writeEventLog, expectedLocalIndexerRoutes } from '../local-indexer-test-helpers.mjs'
import { join, dirname } from 'node:path'
import { createEventLog, rootNode, childNode, prefixed, address, envelope, receipt, order, rootName, ref, bytes, vaultEvents, claimEvents } from '../../scripts/test-fixtures/frozen-events.mjs'
const servers = []
afterEach(async () => { for (const s of servers.splice(0)) await s.close() })
const fixtures = () => [...createEventLog(), vaultEvents(), claimEvents(), envelope(receipt(18, [
  [6, 'order_changed', { order: order('Fixed', 1n) }], [6, 'order_changed', { order: order('Auction', 2n) }], [6, 'order_changed', { order: order('Offer', 3n) }],
  [6, 'refund_changed', { refund: { authority: bytes(14), amount_lux: '9007199254740993' } }],
  [4, 'commitment_created', { commitment: { key: { actor: bytes(10), hash: bytes(24) }, created_at: 18n } }],
]))]
const urls = {
  '/controllers': '',
  '/health': '', '/names': `?owner=${prefixed(10)}`, '/search': '?query=aurora', '/resolve': '?name=aurora', '/verify': '?name=aurora',
  '/name': `?node=${rootNode}`, '/records': `?node=${rootNode}`, '/record': `?node=${rootNode}&key=moonlight_address`,
  '/record-history': `?node=${rootNode}&key=moonlight_address`, '/activity': `?node=${rootNode}`,
  '/subnames': `?parentNode=${rootNode}`, '/subname': `?node=${childNode}`, '/reverse': `?type=moonlight_address&value=${address}`,
  '/treasury': '', '/referrals': `?referrer=${prefixed(13)}`, '/fee-config': '', '/commitment': `?controller=${prefixed(10)}&commitment=${prefixed(24)}`,
  '/marketplace/config': '', '/marketplace/fixed-sales': '', '/marketplace/fixed-sale': `?node=${rootNode}`,
  '/marketplace/auctions': '', '/marketplace/auction': `?node=${rootNode}`, '/marketplace/offers': '',
  '/marketplace/offer': `?node=${rootNode}&buyerAuthority=${prefixed(14)}`, '/marketplace/refund': `?authority=${prefixed(14)}`,
}
it.each(['event-log', 'sqlite'])('serves every frontend route over frozen receipts from %s', async mode => {
  const entries = fixtures(), file = await writeEventLog(entries), cursorFile = await commitJournal(file, {
    version: 2, source: 'rusk-finalized-archive', status: 'running', fromBlock: 1, scannedBlockHeight: 18,
    currentBlockHeight: 18, scannedBlockHash: 'ab'.repeat(32), updatedAt: new Date().toISOString(), eventCount: entries.length,
  })
  const store = mode === 'sqlite' ? await loadSqliteStore(join(dirname(file), 'frozen.sqlite'), { eventLogFile: file, cursorFile }) : await loadEventLogStore(file, cursorFile)
  expect(store.warnings).toEqual([])
  const server = await startServer(store); servers.push(server)
  expect(Object.keys(urls).sort()).toEqual(expectedLocalIndexerRoutes.toSorted())
  const bodies = {}
  for (const [path, query] of Object.entries(urls)) {
    const res = await fetch(server.baseUrl + path + query, { method: path === '/verify' ? 'POST' : 'GET' })
    expect(res.status, path).toBe(200)
    bodies[path] = await res.json()
    expect(bodies[path], path).not.toBeNull()
  }
  expect(bodies['/health']).toMatchObject({ ok: true, readModelSchemaVersion: 2, deployment: { complete: true } })
  expect(bodies['/names'].names[0]).toMatchObject({ homeShard: prefixed(4), generation: '7', namespace: { descendantCount: 1 } })
  expect(bodies['/name'].nameRef.incarnation).toEqual({ generation: '7', serial: '1' })
  expect(bodies['/resolve']).toMatchObject({ verificationStatus: 'forward_resolved', homeShard: prefixed(4), generation: '7' })
  expect(bodies['/records'].records[0]).toMatchObject({ value: address, valueBytes: Array(96).fill(12) })
  expect(bodies['/record-history'].history[0].action).toBe('set')
  expect(bodies['/activity'].activity.some(e => e.eventType === 'root_registered')).toBe(true)
  expect(bodies['/subnames'].subnames[0].name).toBe('x.aurora.dusk')
  expect(bodies['/treasury']).toMatchObject({ accountedLux: '6000000000', availableLux: '5000000000', totalReceivedLux: '10000000000', registrationReceivedLux: '10000000000', referralClaimedLux: '1000000000', claims: [{ amountLux: '3000000000', remainingLux: '5000000000' }] })
  expect(bodies['/referrals']).toMatchObject({ claimableLux: '1000000000', referralCount: 1, recentActivity: [{ amountLux: '1000000000' }, { amountLux: '2000000000' }] })
  expect(bodies['/fee-config']).toMatchObject({ threeCharYearLux: '150000000000', fourCharYearLux: '50000000000', fivePlusYearLux: '10000000000', renewalSchedule: { referral_bps: 1000 } })
  expect(bodies['/marketplace/config'].feeBps).toBe(250)
  expect(bodies['/marketplace/fixed-sales'].fixedSales[0].order.terms.kind).toBe('Fixed')
  expect(bodies['/marketplace/auctions'].auctions[0].orderId).toBe('2')
  expect(bodies['/marketplace/offers'].offers[0].order.terms.kind).toBe('Offer')
  expect(bodies['/marketplace/refund'].amountLux).toBe('9007199254740993')
  expect(bodies['/commitment'].commitmentStore).toBe(prefixed(4))
  for (const [path, type, text] of [
    ['/share/name/aurora.dusk', 'text/html', 'aurora.dusk'],
    ['/page/name/aurora.dusk', 'text/html', 'aurora.dusk'],
    ['/sitemap/names.xml', 'application/xml', 'x.aurora.dusk'],
  ]) {
    const res = await fetch(server.baseUrl + path); expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain(type); expect(await res.text()).toContain(text)
  }
})
it('keeps an old-market refund accessible via marketplace selector', async () => {
  const entries = fixtures(), store = await loadFixture(entries)
  store.marketplaceConfig.marketplaceContractId = prefixed(20)
  store.marketplaceRefundsByAuthority.clear()
  const server = await startServer(store); servers.push(server)
  const r = await fetch(`${server.baseUrl}/marketplace/refund?authority=${prefixed(14)}&marketplace=${prefixed(6)}`)
  expect(await r.json()).toMatchObject({ amountLux: '9007199254740993' })
})

it('paginates multiple order IDs for a node and retrieves an exact old return-pending order', async () => {
  const older = { ...order('Fixed', 1n), status: 'ReturnPending' }, current = order('Fixed', 9n)
  const entries = [...createEventLog(), envelope(receipt(19, [[6, 'order_closed', { order: older, reason: 'Cancelled' }], [6, 'order_changed', { order: current }]]))]
  const server = await startServer(await loadFixture(entries)); servers.push(server)
  const first = await (await fetch(`${server.baseUrl}/marketplace/fixed-sales?limit=1`)).json()
  expect(first.fixedSales[0]).toMatchObject({ orderId: '1', status: 'ReturnPending', escrowed: false })
  const second = await (await fetch(`${server.baseUrl}/marketplace/fixed-sales?limit=1&cursor=${first.nextCursor}`)).json()
  expect(second.fixedSales.map(o => o.orderId)).toEqual(['9'])
  expect(second.nextCursor).toBeNull()
  const exact = await (await fetch(`${server.baseUrl}/marketplace/fixed-sale?node=${rootNode}&orderId=1`)).json()
  expect(exact).toMatchObject({ orderId: '1', status: 'ReturnPending' })
  expect((await fetch(`${server.baseUrl}/marketplace/fixed-sale?node=${rootNode}&orderId=18446744073709551616`)).status).toBe(400)
})

it('selects exact frozen UTF-8 record keys and enforces the 64-byte bound', async () => {
  const keys = ['profile/display', ' display ', ' ', 'é'.repeat(32), '😀'.repeat(16), 'a'.repeat(64), '�', 'space + percent%']
  const records = keys.map((key, i) => wireValue('RecordValue', { ...validateRecordInput({ key, value: [...Buffer.from(`value-${i}`)], ttl_seconds: 300n }), updated_at: 20n }))
  const snapshot = { records, count: records.length, digest: recordsDigest(records) }
  const entries = [...createEventLog(), envelope(receipt(20, [
    [5, 'resolver_slot_written', { slot: { registry: bytes(4), node: rootName().key.node, epoch: 1n }, snapshot }],
    [4, 'slot_changed', { name: ref(rootName()), previous: null, reason: 'Mutation',
      current: { resolver: bytes(5), epoch: 1n, count: snapshot.count, digest: snapshot.digest } }],
  ]))]
  const store = await loadFixture(entries)
  expect(store.warnings).toEqual([])
  const server = await startServer(store); servers.push(server)
  for (const [i, key] of keys.entries()) {
    for (const route of ['/record', '/record-history']) {
      const response = await fetch(`${server.baseUrl}${route}?node=${rootNode}&key=${encodeURIComponent(key)}`)
      expect(response.status, `${route} ${JSON.stringify(key)}`).toBe(200)
      const body = await response.json()
      const row = route === '/record' ? body : body.history[0]
      expect(row).toMatchObject({ key, value: `value-${i}` })
      if (route === '/record-history') expect(body.history.every(r => r.key === key)).toBe(true)
    }
  }
  for (const key of ['a'.repeat(65), 'é'.repeat(33), '😀'.repeat(17)]) {
    for (const route of ['/record', '/record-history']) {
      const response = await fetch(`${server.baseUrl}${route}?node=${rootNode}&key=${encodeURIComponent(key)}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_record_key' })
    }
  }
  for (const key of ['%FF', '%C0%AF', '%ED%A0%80', '%']) {
    for (const route of ['/record', '/record-history']) {
      expect((await fetch(`${server.baseUrl}${route}?node=${rootNode}&key=${key}`)).status).toBe(400)
    }
  }
  expect((await fetch(`${server.baseUrl}/record?node=${rootNode}`)).status).toBe(400)
})

it.each(['/record', '/record-history'])('rejects empty keys before store loading on %s', async route => {
  expect(() => validateRecordInput({ key: '', value: [1], ttl_seconds: 1n })).toThrow('key_bytes')
  let loads = 0
  const server = await startServer(() => { loads++; throw new Error('Store must not load') }, { logger: { error() {} } })
  servers.push(server)
  const response = await fetch(`${server.baseUrl}${route}?node=${rootNode}&key=`)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: 'invalid_record_key' })
  expect(loads).toBe(0)
})

async function loadFixture(entries) {
  const file = await writeEventLog(entries)
  return loadEventLogStore(file, await commitJournal(file))
}
