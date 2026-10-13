import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fromHex, hex } from '@duskdomains/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { binding, bytes, createEventLog, directory, envelope, order, receipt, recordEffects, rootNode } from '../../scripts/test-fixtures/frozen-events.mjs'
import { blockHash, feeTx, marketDeployment, marketInitializationEntry, marketReceipt, marketplaceConfig, preferMarketplace, setMarketplace }
  from '../../scripts/test-fixtures/market-replacement.mjs'
import { loadEventLogStore, loadSqliteStore } from '../local-indexer.mjs'
import { startServer, writeEventLog } from '../local-indexer-test-helpers.mjs'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'

const servers = [], indexers = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const i of indexers.splice(0)) i.close()
})

const replacement = marketDeployment(), market = `0x${replacement.market}`
const head = 22

// Launch history, then the replacement market: deployed at 15 and set to 300 bps at 16, both before
// governance listed it at 20, which the collector journals after the admission; preferred at 21.
function replacedLog(...extra) {
  return [...createEventLog(), envelope(receipt(20, [setMarketplace(20, replacement)])), marketInitializationEntry(replacement),
    envelope(receipt(21, [preferMarketplace(21, replacement)])), ...extra]
}

async function open(mode, entries, height = head) {
  const file = await writeEventLog(entries), cursorFile = await commitJournal(file, { scannedBlockHeight: height, currentBlockHeight: height })
  if (mode === 'incremental') {
    const provider = await createIncrementalSqliteStore({ file: join(dirname(file), 'incremental.sqlite'), eventLogFile: file, cursorFile })
    indexers.push(provider.indexer)
    return provider
  }
  return mode === 'sqlite'
    ? loadSqliteStore(join(dirname(file), 'replacement.sqlite'), { eventLogFile: file, cursorFile })
    : loadEventLogStore(file, cursorFile)
}

async function serve(store) {
  const server = await startServer(store)
  servers.push(server)
  return async path => {
    const response = await fetch(server.baseUrl + path)
    return { status: response.status, body: await response.json() }
  }
}

const modes = ['event-log', 'sqlite', 'incremental']

describe('a marketplace listed after launch', () => {
  it.each(modes)('serves the configuration it reached before admission as soon as SetMarketplace executes (%s)', async mode => {
    const store = await open(mode, replacedLog())
    const read = await serve(store), published = mode === 'incremental' ? await store() : store
    expect(published.warnings).toEqual([])
    const config = (await read('/marketplace/config')).body
    expect(config).toMatchObject({ initialized: true, marketplaceContractId: market, feeBps: 300, tradingPaused: true,
      config: { fee_bps: 300, new_orders_disabled: true, next_order_id: '1', unsettled_orders: '0' } })
    expect((await read(`/marketplace/config?marketplace=${market}`)).body).toEqual(config)
    expect(config.marketplaces.find(m => m.marketplaceContractId === market)).toEqual({ marketplaceContractId: market, state: 'Listed',
      preferred: true, authenticated: true, initialized: true, tradingPaused: true, feeBps: 300, unsettledOrders: 0, refundAccounts: 0, refundableLux: '0',
      holdsObligations: false })
    expect((await read('/health')).body).toMatchObject({ ok: true, pause: { tradingPaused: true } })
  })

  it('serves identical market configurations from the event log, SQLite and incremental SQLite', async () => {
    const readers = Object.fromEntries(await Promise.all(modes.map(async mode => [mode, await serve(await open(mode, replacedLog()))])))
    for (const path of ['/marketplace/config', `/marketplace/config?marketplace=${market}`, '/marketplace/config?marketplace=0x' + hex(bytes(6))]) {
      const expected = await readers['event-log'](path)
      expect(expected.status, path).toBe(200)
      for (const mode of ['sqlite', 'incremental']) expect(await readers[mode](path), `${mode} ${path}`).toEqual(expected)
    }
    for (const mode of ['sqlite', 'incremental'])
      expect((await readers[mode]('/health')).body.pause).toEqual((await readers['event-log']('/health')).body.pause)
  })

  it('serves its own configuration once it emits one after admission', async () => {
    const opened = marketplaceConfig(binding, { fee_bps: 300, new_orders_disabled: false })
    const read = await serve(await open('event-log', replacedLog(envelope(marketReceipt(22, replacement, opened, 'cd'.repeat(32), 3n)))))
    expect((await read('/marketplace/config')).body).toMatchObject({ initialized: true, feeBps: 300, tradingPaused: false })
    expect((await read('/health')).body.pause).toMatchObject({ tradingPaused: false })
  })

  it('serves an initialization appended later to a running incremental SQLite store', async () => {
    const file = await writeEventLog([...createEventLog(), envelope(receipt(20, [setMarketplace(20, replacement)]))])
    const cursorFile = await commitJournal(file, { scannedBlockHeight: 21, currentBlockHeight: 21 })
    const provider = await createIncrementalSqliteStore({ file: join(dirname(file), 'tail.sqlite'), eventLogFile: file, cursorFile })
    indexers.push(provider.indexer)
    expect((await provider()).marketplaceConfigs[market]).toBeUndefined()
    await appendFile(file, JSON.stringify(marketInitializationEntry(replacement, { journaledAt: 22 })) + '\n')
    await commitJournal(file, { scannedBlockHeight: 22, currentBlockHeight: 22 }, cursorFile)
    const store = await provider()
    expect(store.warnings).toEqual([])
    expect(store.marketplaceConfigs[market]).toMatchObject({ initialized: true, feeBps: 300 })
  })

  it('never serves a default fee for an admitted market without an authenticated configuration', async () => {
    const read = await serve(await open('event-log', [...createEventLog(), envelope(receipt(20, [setMarketplace(20, replacement)])),
      envelope(receipt(21, [preferMarketplace(21, replacement)]))]))
    expect((await read('/marketplace/config')).body).toMatchObject({ initialized: false, marketplaceContractId: market, feeBps: null,
      tradingPaused: true, config: null })
    expect((await read(`/marketplace/config?marketplace=${market}`)).body).toMatchObject({ initialized: false, feeBps: null, tradingPaused: true })
    expect((await read('/health')).body.pause).toMatchObject({ tradingPaused: true })
  })
})

describe('marketplace initializations that must not be served', () => {
  const written = async entries => {
    const file = await writeEventLog(entries)
    return [file, await commitJournal(file, { scannedBlockHeight: head, currentBlockHeight: head })]
  }
  const blocked = async (entries, message) => {
    const store = await loadEventLogStore(...await written(entries))
    expect(store.warnings.map(w => w.message).join('\n')).toMatch(message)
    expect((await (await serve(store))('/marketplace/config')).status).toBe(503)
  }
  const listed = (d = replacement) => envelope(receipt(20, [setMarketplace(20, d)]))

  it('rejects an initialization for a marketplace that governance never admitted', async () => {
    await blocked([...createEventLog(), marketInitializationEntry(replacement)], /not admitted/)
  })

  it('rejects a configuration emitted by another contract', async () => {
    const forged = marketReceipt(16, replacement, marketplaceConfig(binding, { fee_bps: 300 }), feeTx, 2n)
    forged.events[1] = { ...forged.events[1], emitter: hex(bytes(77)) }
    await blocked([...createEventLog(), listed(), marketInitializationEntry(replacement, { receipt: forged })], /another emitter/)
  })

  it('rejects a receipt that commits anything besides the configuration', async () => {
    const forged = marketReceipt(16, replacement, marketplaceConfig(binding, { fee_bps: 300 }), feeTx, 2n)
    forged.events[1] = { ...forged.events[1], topic: 'order_changed', data: { ...forged.events[1].data, body: { order: order('Fixed', 1n) } } }
    await blocked([...createEventLog(), listed(), marketInitializationEntry(replacement, { receipt: forged })], /only its configuration/)
  })

  it.each([
    ['code hash', { evidence: { codeHash: hex(bytes(66)) } }, /code hash differs/],
    ['init hash', { evidence: { initArchive: hex(marketDeployment({ bind: { ...binding, vault: bytes(99) } }).archive) } }, /init archive differs/],
    ['binding', { config: marketplaceConfig({ ...binding, vault: bytes(99) }, { fee_bps: 300 }) }, /binding differs/],
    ['configuration after admission', { configuredAt: 21, journaledAt: 21 }, /precede its admission/],
    ['configuration before deployment', { deployedAt: 17 }, /follow deployment/],
  ])('rejects a mismatched %s', async (_label, options, message) => {
    await blocked([...createEventLog(), listed(), marketInitializationEntry(replacement, options)], message)
  })

  it('serves an authenticated configuration only while the market\'s record pins the same evidence', async () => {
    // A later record of the same market with other evidence cannot happen on chain; the guard holds anyway.
    const config = directory().config
    config.revision = config.registration.revision = 22n
    config.preferred_marketplace = fromHex(replacement.market, 32)
    const record = { id: fromHex(replacement.market, 32), state: 'Listed', version: 2n, interface_version: 1,
      code_hash: bytes(66), init_hash: fromHex(replacement.initHash, 32) }
    const read = await serve(await loadEventLogStore(...await written(replacedLog(envelope(receipt(22, [[1, 'action_applied', {
      id: { operator_epoch: 1n, nonce: 22n }, action: { SetMarketplace: { expected_version: 1n, market: record.id, state: 'Listed',
        interface_version: 1, code_hash: record.code_hash, init_hash: record.init_hash } }, config, admission: null, market: record }]]))))))
    expect((await read('/marketplace/config')).body).toMatchObject({ initialized: false, feeBps: null, tradingPaused: true })
  })
})

describe('a marketplace whose deployment is not authenticated', () => {
  // Governance lists a look-alike whose record does not match its deployment, so no initialization
  // row authenticates it. After admission it configures itself unpaused at 999 bps and lists an order.
  const lookalike = marketDeployment({ wasm: 'look-alike marketplace' }), id = `0x${lookalike.market}`
  const own = (height, topic, body, origin, opSeq) => {
    const path = [fromHex(lookalike.market, 32)], at = BigInt(height)
    return envelope({ id: `${blockHash(height)}:${origin}`, height: at, success: true, events: [
      { emitter: lookalike.market, topic: 'operation_begin', data: { op_seq: opSeq, height: at, call_path: path }, reverted: false, ordinal: 0 },
      { emitter: lookalike.market, topic, data: { version: 1, op_seq: opSeq, body }, reverted: false, ordinal: 1 },
      { emitter: lookalike.market, topic: 'operation_end', data: { op_seq: opSeq, call_path: path }, reverted: false, ordinal: 2 },
    ] })
  }
  const history = () => [...createEventLog(), envelope(receipt(20, [setMarketplace(20, lookalike, { codeHash: hex(bytes(66)) })])),
    own(21, 'market_configured', { config: marketplaceConfig(binding, { fee_bps: 999, new_orders_disabled: false }) }, 'c1'.repeat(32), 3n),
    own(21, 'order_changed', { order: order('Fixed', 1n) }, 'c2'.repeat(32), 4n),
    envelope(receipt(21, [preferMarketplace(21, lookalike)]))]

  it.each(modes)('serves none of its later configuration or orders (%s)', async mode => {
    const read = await serve(await open(mode, history()))
    const config = (await read('/marketplace/config')).body
    expect(config).toMatchObject({ initialized: false, marketplaceContractId: id, feeBps: null, tradingPaused: true, config: null })
    expect((await read(`/marketplace/config?marketplace=${id}`)).body).toMatchObject({ initialized: false, feeBps: null, tradingPaused: true })
    expect(config.marketplaces.find(m => m.marketplaceContractId === id)).toEqual({ marketplaceContractId: id, state: 'Listed', preferred: true,
      authenticated: false, initialized: false, tradingPaused: true, feeBps: null, unsettledOrders: null, refundAccounts: null, refundableLux: null,
      holdsObligations: null })
    expect((await read('/marketplace/fixed-sales?marketplace=all')).body.fixedSales).toEqual([])
    expect((await read(`/marketplace/fixed-sale?node=0x${hex(order('Fixed', 1n).terms.name.key.node)}&marketplace=${id}`)).body).toBeNull()
    expect((await read('/health')).body.pause).toMatchObject({ tradingPaused: true })
  })
})

describe('a marketplace\'s events in public history', () => {
  // Its own receipt with one effect, after its admission.
  const own = (d, height, topic, body, origin, opSeq) => {
    const path = [fromHex(d.market, 32)], at = BigInt(height)
    return envelope({ id: `${blockHash(height)}:${origin}`, height: at, success: true, events: [
      { emitter: d.market, topic: 'operation_begin', data: { op_seq: opSeq, height: at, call_path: path }, reverted: false, ordinal: 0 },
      { emitter: d.market, topic, data: { version: 1, op_seq: opSeq, body }, reverted: false, ordinal: 1 },
      { emitter: d.market, topic: 'operation_end', data: { op_seq: opSeq, call_path: path }, reverted: false, ordinal: 2 },
    ] })
  }
  const history = async (mode, entries) => {
    const read = await serve(await open(mode, entries))
    const name = (await read(`/name?node=${rootNode}`)).body
    return { activity: (await read(`/activity?node=${rootNode}&limit=200`)).body.activity, lastEventType: name.lastEventType, updatedAt: name.updatedAt }
  }

  it.each(modes)('never shows an unauthenticated market\'s events on a name (%s)', async mode => {
    const lookalike = marketDeployment({ wasm: 'look-alike marketplace' })
    const listed = [...createEventLog(), envelope(receipt(20, [setMarketplace(20, lookalike, { codeHash: hex(bytes(66)) })]))]
    const before = await history(mode, listed)
    // Its order names aurora.dusk; the market is not authenticated, so the name's history is unchanged.
    const after = await history(mode, [...listed, own(lookalike, 21, 'order_changed', { order: order('Fixed', 1n) }, 'c2'.repeat(32), 4n)])
    expect(after).toEqual(before)
    expect(after.activity.some(row => row.contractId === `0x${lookalike.market}`)).toBe(false)
  })

  it.each(modes)('shows a market\'s events once it authenticates, complete and in order (%s)', async mode => {
    // Listed at 20; its order at 21 comes before its initialization row, journaled at 22 after
    // a record change of the same name.
    const listed = [...createEventLog(), envelope(receipt(20, [setMarketplace(20, replacement)])),
      own(replacement, 21, 'order_changed', { order: order('Fixed', 1n) }, 'c2'.repeat(32), 4n), envelope(receipt(22, recordEffects('later')))]
    const pending = await history(mode, listed)
    expect(pending.activity.some(row => row.contractId === market)).toBe(false)
    const authenticated = await history(mode, [...listed, marketInitializationEntry(replacement, { journaledAt: 22 })])
    const rows = authenticated.activity.map(row => [row.blockHeight, row.contractId, row.eventType])
    expect(rows).toContainEqual([21, market, 'order_changed'])
    // Newest first, with the market's order between what came before and after it.
    expect(rows).toEqual(rows.toSorted((a, b) => b[0] - a[0]))
    expect(authenticated.activity.filter(row => row.contractId !== market)).toEqual(pending.activity)
    expect([authenticated.lastEventType, authenticated.updatedAt]).toEqual([pending.lastEventType, pending.updatedAt])
  })
})
