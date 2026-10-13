import { afterEach, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fromHex, hex } from '@duskdomains/sdk'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { loadEventLogStore, loadSqliteStore } from '../local-indexer.mjs'
import { startServer, writeEventLog } from '../local-indexer-test-helpers.mjs'
import { binding, bytes, createEventLog, directory, envelope, marketConfig, order, prefixed, receipt, rootNode, sample } from '../../scripts/test-fixtures/frozen-events.mjs'
import { marketDeployment, marketInitializationEntry, marketplaceConfig } from '../../scripts/test-fixtures/market-replacement.mjs'

const servers = []
afterEach(async () => { for (const s of servers.splice(0)) await s.close() })

// Market 20 is listed after launch; its initialization row authenticates its deployment.
const deployed = { ...marketDeployment(), market: hex(bytes(20)) }
const newMarket = { id: bytes(20), state: 'Listed', version: 1n, interface_version: 1,
  code_hash: fromHex(deployed.codeHash, 32), init_hash: fromHex(deployed.initHash, 32) }
function directoryAction(height, nonce, action, change = () => {}, market = null) {
  const config = directory().config
  config.revision = config.registration.revision = BigInt(height)
  change(config)
  return [1, 'action_applied', { id: { operator_epoch: 1n, nonce }, action, config, admission: null, market }]
}
const offerBy = (buyer, number) => {
  const offer = order('Offer', number)
  return { ...offer, terms: { ...offer.terms, buyer: bytes(buyer), buyer_manager: bytes(buyer) } }
}
// Market 6 holds a listing, an auction, an offer and a refund. Governance then lists market 20,
// authenticated, where the same buyer offers again under the same order ID, and prefers it.
const history = () => [...createEventLog(), envelope(receipt(18, [
  [6, 'order_changed', { order: order('Fixed', 1n) }], [6, 'order_changed', { order: order('Auction', 2n) }],
  [6, 'order_changed', { order: order('Offer', 3n) }],
  [6, 'refund_changed', { refund: { authority: bytes(14), amount_lux: '5000000000' } }],
])), envelope(receipt(19, [directoryAction(19, 1n, { SetMarketplace: { expected_version: 0n, market: bytes(20), state: 'Listed',
  interface_version: 1, code_hash: newMarket.code_hash, init_hash: newMarket.init_hash } }, c => { c.market_version = 2n }, newMarket)])),
marketInitializationEntry(deployed, { journaledAt: 19, config: marketplaceConfig(binding, { fee_bps: 300 }) }),
envelope(receipt(20, [[20, 'market_configured', { config: { ...marketConfig(), fee_bps: 300 } }],
  [20, 'order_changed', { order: offerBy(16, 1n) }], [20, 'order_changed', { order: offerBy(14, 3n) }]])),
envelope(receipt(21, [directoryAction(21, 2n, { SetPreferredMarketplace: { expected_version: 2n, market: bytes(20) } },
  c => { c.preferred_marketplace = bytes(20); c.market_version = 3n })]))]

async function serve(mode, entries = history()) {
  const file = await writeEventLog(entries), cursorFile = await commitJournal(file)
  const store = mode === 'sqlite'
    ? await loadSqliteStore(join(dirname(file), 'markets.sqlite'), { eventLogFile: file, cursorFile })
    : await loadEventLogStore(file, cursorFile)
  expect(store.warnings).toEqual([])
  const server = await startServer(store); servers.push(server)
  return async (path, status = 200) => {
    const response = await fetch(server.baseUrl + path)
    expect(response.status, path).toBe(status)
    return response.json()
  }
}
const orders = rows => rows.map(o => [o.marketplaceContractId, o.kind, o.orderId]).sort()

it.each(['event-log', 'sqlite'])('keeps a market\'s open orders and refunds visible after SetPreferredMarketplace moves away from it (%s)', async mode => {
  const get = await serve(mode), old = prefixed(6), preferred = prefixed(20)
  // Existing routes keep serving the preferred market by default.
  expect((await get('/marketplace/fixed-sales')).fixedSales).toEqual([])
  expect(orders((await get('/marketplace/offers')).offers)).toEqual([[preferred, 'Offer', '1'], [preferred, 'Offer', '3']])
  expect(await get(`/marketplace/refund?authority=${prefixed(14)}`)).toBeNull()
  // `marketplace=all` lists every admitted market's obligations, each row naming its market.
  expect(orders((await get('/marketplace/fixed-sales?marketplace=all')).fixedSales)).toEqual([[old, 'Fixed', '1']])
  expect(orders((await get('/marketplace/auctions?marketplace=all')).auctions)).toEqual([[old, 'Auction', '2']])
  expect(orders((await get(`/marketplace/offers?marketplace=all&node=${rootNode}`)).offers))
    .toEqual([[old, 'Offer', '3'], [preferred, 'Offer', '1'], [preferred, 'Offer', '3']])
  expect(orders((await get(`/marketplace/offers?marketplace=all&buyerAuthority=${prefixed(14)}`)).offers))
    .toEqual([[old, 'Offer', '3'], [preferred, 'Offer', '3']])
  expect(await get(`/marketplace/fixed-sale?node=${rootNode}&marketplace=all`)).toMatchObject({ marketplaceContractId: old, orderId: '1', kind: 'Fixed' })
  expect(await get(`/marketplace/auction?node=${rootNode}&marketplace=all`)).toMatchObject({ marketplaceContractId: old, orderId: '2' })
  // A singular route answers the latest indexed match across markets; name the market to pick another.
  expect(await get(`/marketplace/offer?node=${rootNode}&buyerAuthority=${prefixed(14)}&marketplace=all`)).toMatchObject({ marketplaceContractId: preferred, orderId: '3' })
  expect(await get(`/marketplace/offer?node=${rootNode}&buyerAuthority=${prefixed(14)}&marketplace=${old}`)).toMatchObject({ marketplaceContractId: old, orderId: '3' })
  // A user's refunds in every market, from one route.
  expect(await get(`/marketplace/refunds?authority=${prefixed(14)}`))
    .toEqual({ refunds: [{ marketplaceContractId: old, authority: prefixed(14), amountLux: '5000000000' }], nextCursor: null })
  expect(await get(`/marketplace/refunds?authority=${prefixed(14)}&marketplace=${preferred}`)).toEqual({ refunds: [], nextCursor: null })
  expect(await get(`/marketplace/refunds?authority=${prefixed(14)}&marketplace=all`)).toMatchObject({ refunds: [{ marketplaceContractId: old }] })
  // The config names every admitted market, its state, whether it is preferred and what it still holds.
  const config = await get('/marketplace/config')
  expect(config).toMatchObject({ initialized: true, marketplaceContractId: preferred, feeBps: 300 })
  expect(config.marketplaces).toEqual([
    { marketplaceContractId: old, state: 'Listed', preferred: false, authenticated: true, initialized: true, tradingPaused: false, feeBps: 250,
      unsettledOrders: 3, refundAccounts: 1, refundableLux: '5000000000', holdsObligations: true },
    { marketplaceContractId: preferred, state: 'Listed', preferred: true, authenticated: true, initialized: true, tradingPaused: false, feeBps: 300,
      unsettledOrders: 2, refundAccounts: 0, refundableLux: '0', holdsObligations: true },
  ])
  expect((await get(`/marketplace/config?marketplace=${old}`)).marketplaces).toEqual(config.marketplaces)
})

it('pages every market\'s orders with the same node and order ID exactly once', async () => {
  const get = await serve('event-log'), seen = []
  let cursor = null
  do {
    const page = await get(`/marketplace/offers?marketplace=all&limit=1${cursor ? `&cursor=${cursor}` : ''}`)
    seen.push(...page.offers.map(o => [o.marketplaceContractId, o.orderId]))
    cursor = page.nextCursor
  } while (cursor)
  expect(seen).toEqual([[prefixed(6), '3'], [prefixed(20), '3'], [prefixed(20), '1']])
})

it('refuses `marketplace=all` where one answer must name one market', async () => {
  const get = await serve('event-log')
  for (const path of ['/marketplace/config?marketplace=all', `/marketplace/refund?authority=${prefixed(14)}&marketplace=all`])
    expect(await get(path, 400)).toMatchObject({ error: 'invalid_marketplace' })
  expect(await get('/marketplace/refunds', 400)).toMatchObject({ error: 'missing_authority' })
})

it('reports a draining market as not taking new orders while its obligations stay listed', async () => {
  const old = sample('Market'), draining = { ...old, id: bytes(6), state: 'Draining', version: 2n, interface_version: 1 }
  const get = await serve('event-log', [...history(), envelope(receipt(22, [directoryAction(22, 3n, { SetMarketplace: { expected_version: 1n,
    market: bytes(6), state: 'Draining', interface_version: 1, code_hash: old.code_hash, init_hash: old.init_hash } },
    c => { c.preferred_marketplace = bytes(20); c.market_version = 4n }, draining)]))])
  const summary = (await get('/marketplace/config')).marketplaces.find(m => m.marketplaceContractId === prefixed(6))
  expect(summary).toMatchObject({ state: 'Draining', tradingPaused: true, holdsObligations: true, unsettledOrders: 3 })
  expect((await get(`/marketplace/config?marketplace=${prefixed(6)}`)).tradingPaused).toBe(true)
  expect(orders((await get('/marketplace/auctions?marketplace=all')).auctions)).toEqual([[prefixed(6), 'Auction', '2']])
})

it('describes a market it has no configuration for without inventing one', async () => {
  const get = await serve('event-log')
  expect(await get(`/marketplace/config?marketplace=${prefixed(77)}`)).toMatchObject({ initialized: false, marketplaceContractId: prefixed(77),
    tradingPaused: true, feeBps: null, config: null })
})
