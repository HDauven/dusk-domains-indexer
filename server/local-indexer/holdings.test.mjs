import { authority, nameKey } from '@duskdomains/sdk'
import { join, dirname } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { createEventLog, makeName, envelope, receipt, registered, counters, rootNode, childNode, prefixed, bytes, endpoint, ref, rootName }
  from '../../scripts/test-fixtures/frozen-events.mjs'
import { loadEventLogStore, loadSqliteStore } from '../local-indexer.mjs'
import { startServer, writeEventLog, writeSnapshot } from '../local-indexer-test-helpers.mjs'
import { createLocalIndexerHandler } from './routes.mjs'
import { loadSnapshotStore } from './snapshot.mjs'

const servers = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })

const holder = bytes(30), holderManager = bytes(31)
const subname = (spelling, serial, fields) => ({ ...makeName(spelling, serial), owner: holder, manager: holderManager,
  subname: { parent: nameKey(spelling.split('.').slice(1).join('.')).node, depth: 1, expiry_policy: 'InheritsParent', created_at: 15n }, ...fields })
// aurora.dusk and x.aurora.dusk come from createEventLog: owner bytes(10), managers the endpoint and bytes(11).
// Height 15 gives bytes(30) a subname under aurora.dusk, a root that expires at 16, a root
// released at 17 and a subname with a fixed expiry at 16.
function holdingsLog() {
  const other = { ...makeName('other.dusk'), owner: holder, manager: holder, expires_at: 16n, grace_end: 2000n }
  const gone = { ...makeName('gone.dusk'), owner: holder, manager: holder, expires_at: 16n, grace_end: 17n }
  return [...createEventLog(), envelope(receipt(15, [
    [4, 'subname_created', { name: subname('given.aurora.dusk', 3n), actor: bytes(10) }],
    [4, 'subname_created', { name: subname('old.aurora.dusk', 4n, { manager: holder, expires_at: 16n,
      subname: { parent: nameKey('aurora.dusk').node, depth: 1, expiry_policy: 'FixedBeforeParent', created_at: 15n } }), actor: bytes(10) }],
    [4, 'root_registered', registered(other)], [4, 'root_counters_changed', { root: other.key.root, counters }],
    [4, 'root_registered', registered(gone)], [4, 'root_counters_changed', { root: gone.key.root, counters }],
  ]))]
}

// The finalized clock is height 20, after both expiries at 16 and the released grace end at 17.
async function serve(mode, entries, height = 20) {
  const file = await writeEventLog(entries), cursorFile = await commitJournal(file, { scannedBlockHeight: height, currentBlockHeight: height })
  const store = mode === 'sqlite'
    ? await loadSqliteStore(join(dirname(file), 'holdings.sqlite'), { eventLogFile: file, cursorFile })
    : await loadEventLogStore(file, cursorFile)
  expect(store.warnings).toEqual([])
  const server = await startServer(store)
  servers.push(server)
  return async path => {
    const response = await fetch(server.baseUrl + path)
    return { status: response.status, body: await response.json() }
  }
}

const names = body => body.holdings.map(row => [row.name, row.kind, row.role])

it.each(['event-log', 'sqlite'])('lists every held root and subname by its owner and manager from %s', async mode => {
  const read = await serve(mode, holdingsLog())
  const mine = await read(`/holdings?authority=${prefixed(30)}`)
  expect(mine.status).toBe(200)
  // The released root and the expired subname are no longer held; the root in grace still is.
  expect(names(mine.body)).toEqual([['given.aurora.dusk', 'subname', 'owner'], ['other.dusk', 'root', 'owner']])
  expect(mine.body.holdings[0]).toEqual({ node: `0x${Buffer.from(nameKey('given.aurora.dusk').node).toString('hex')}`, name: 'given.aurora.dusk',
    kind: 'subname', role: 'owner', root: rootNode, parentNode: rootNode, parentName: 'aurora.dusk', owner: prefixed(30), manager: prefixed(31),
    status: 'active', expiresAtBlockHeight: 1000, graceEndsAtBlockHeight: null, homeShard: prefixed(4), generation: '7', serial: '3' })
  expect(mine.body.holdings[1]).toMatchObject({ kind: 'root', root: mine.body.holdings[1].node, parentNode: null, parentName: null,
    status: 'grace', expiresAtBlockHeight: 16, graceEndsAtBlockHeight: 2000 })
  expect(mine.body.nextCursor).toBeNull()
  expect(names((await read(`/holdings?authority=${prefixed(31)}`)).body)).toEqual([['given.aurora.dusk', 'subname', 'manager']])
  expect(names((await read(`/holdings?authority=${prefixed(11)}`)).body)).toEqual([['x.aurora.dusk', 'subname', 'manager']])
  const manager = authority({ kind: 'Moonlight', bytes: endpoint })
  expect(names((await read(`/holdings?authority=0x${Buffer.from(manager).toString('hex').toUpperCase()}`)).body)).toEqual([['aurora.dusk', 'root', 'manager']])
  expect((await read(`/holdings?authority=${prefixed(99)}`)).body).toEqual({ holdings: [], nextCursor: null })
  // Pages follow name order and continue from an opaque cursor.
  const first = await read(`/holdings?authority=${prefixed(10)}&limit=1`)
  expect(names(first.body)).toEqual([['aurora.dusk', 'root', 'owner']])
  const second = await read(`/holdings?authority=${prefixed(10)}&limit=1&cursor=${first.body.nextCursor}`)
  expect(second.body).toMatchObject({ holdings: [{ name: 'x.aurora.dusk', node: childNode, kind: 'subname', role: 'owner' }], nextCursor: null })
  expect((await read(`/holdings?authority=${prefixed(11)}&cursor=${first.body.nextCursor}`)).body.error).toBe('invalid_cursor')
  expect((await read('/holdings')).body.error).toBe('missing_authority')
  expect((await read('/holdings?authority=nightowls.dusk')).body.error).toBe('invalid_authority')
  expect((await read('/health')).body.routes).toContain('/holdings')
})

it('serves the same holdings from the event log and SQLite', async () => {
  const [log, sqlite] = await Promise.all(['event-log', 'sqlite'].map(mode => serve(mode, holdingsLog())))
  for (const who of [10, 11, 30, 31]) {
    for (const query of ['', '&limit=1']) {
      const path = `/holdings?authority=${prefixed(who)}${query}`, served = await log(path)
      expect(served.status, path).toBe(200)
      expect(served.body.holdings.length, path).toBeGreaterThan(0)
      expect(await sqlite(path), path).toEqual(served)
    }
  }
})

it.each(['event-log', 'sqlite'])('files a renewal paid from a listing under the name with its payer from %s', async mode => {
  const n = rootName(), market = { kind: 'Contract', bytes: bytes(6) }, payer = { kind: 'Moonlight', bytes: endpoint }
  const read = await serve(mode, [...createEventLog(), envelope(receipt(16, [
    [6, 'escrow_renewed', { order_id: 4n, payer, renewal: { name: ref(n), years: 1, expected_schedule_version: 1n,
      expected_fee_lux: '10000000000', valid_until: 16n } }],
    [4, 'root_renewed', { root: ref(n), old_expiry: 1000n, expires_at: 3154600n, old_grace_end: 2000n, grace_end: 3413800n,
      inheritance_rule: 1, years: 1, payer: market, fee_lux: '10000000000', referral_lux: '1000000000', schedule_version: 1n }],
  ], 'tx-escrow-renew'))])
  const { activity } = (await read(`/activity?node=${rootNode}`)).body
  const escrow = activity.find(row => row.eventType === 'escrow_renewed'), renewed = activity.find(row => row.eventType === 'root_renewed')
  expect(escrow).toMatchObject({ node: rootNode, txId: 'tx-escrow-renew', contractId: prefixed(6), data: { order_id: '4', payer: { kind: 'Moonlight', bytes: endpoint } } })
  // The store's own renewal event names the market contract as the payer; the market's event names who paid it.
  expect(renewed).toMatchObject({ txId: 'tx-escrow-renew', data: { payer: { kind: 'Contract', bytes: bytes(6) } } })
})

it('serves holdings in snapshot mode', async () => {
  const owner = prefixed(40), node = prefixed(0x41), sub = prefixed(0x42)
  const store = await loadSnapshotStore(await writeSnapshot({
    names: [{ canonicalName: 'night.dusk', node, owner: prefixed(41), manager: prefixed(41), status: 'active', expiresAtBlockHeight: 900, graceEndsAtBlockHeight: 1000, records: [] }],
    subnames: [{ name: 'maya.night.dusk', node: sub, parentNode: node, owner, manager: owner, status: 'active', expiresAtBlockHeight: 900 }],
    cursor: { lastBlockHeight: 10 },
  }))
  const server = await startServer(store)
  servers.push(server)
  const body = await (await fetch(`${server.baseUrl}/holdings?authority=${owner}`)).json()
  expect(body).toEqual({ holdings: [expect.objectContaining({ name: 'maya.night.dusk', kind: 'subname', role: 'owner', root: node, parentName: 'night.dusk' })], nextCursor: null })
})

it('reports a missing holder index instead of scanning names', async () => {
  const handler = createLocalIndexerHandler({ namesByCanonical: { values() { throw new Error('scanned names') } } })
  const response = await new Promise(resolve => handler({ url: `/holdings?authority=${prefixed(10)}`, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, {
    writeHead(status) { this.status = status }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }) },
  }))
  expect(response).toEqual({ status: 503, body: { error: 'holder_index_unavailable', message: 'The holder index is unavailable.' } })
})
