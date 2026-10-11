import { afterEach, expect, it } from 'vitest'
import { join, dirname } from 'node:path'
import { loadEventLogStore, loadSqliteStore } from '../local-indexer.mjs'
import { startServer, writeEventLog } from '../local-indexer-test-helpers.mjs'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { createEventLog, envelope, receipt, admission, bytes, id, prefixed, sample, rootName, rootNode, childNode, registered, counters, directory } from '../../scripts/test-fixtures/frozen-events.mjs'
import { admissions, topicsFor } from '../../scripts/local-event-collector/frozen.mjs'
const servers = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
const controller = (who = 41) => ({ contract: bytes(who), scopes: who === 41 ? 7 : 1, admitted_at: 15n, suspended: false })
const change = (who, version, listed = true, suspended = false) => [1, 'controller_changed', { controller: { ...controller(who), suspended }, listed, version }]
function controllers() {
  return [...createEventLog(), envelope(receipt(15, [change(41, 2n), change(42, 3n)])),
    envelope(receipt(17, [[1, 'controller_suspension_changed', { controller: bytes(41), suspended: true, actor: { kind: 'Contract', bytes: bytes(50) }, version: 4n }]]))]
}
async function load(entries, mode = 'event-log') {
  const file = await writeEventLog(entries), cursorFile = await commitJournal(file)
  const store = mode === 'sqlite' ? await loadSqliteStore(join(dirname(file), 'logic.sqlite'), { eventLogFile: file, cursorFile }) : await loadEventLogStore(file, cursorFile)
  expect(store.warnings).toEqual([])
  return store
}
async function serve(store) {
  const server = await startServer(store); servers.push(server)
  return async path => { const response = await fetch(server.baseUrl + path); return { status: response.status, body: await response.json() } }
}
it.each(['event-log', 'sqlite'])('projects and serves controller scope and suspension from %s', async mode => {
  const store = await load(controllers(), mode), get = await serve(store)
  expect(store.controllers).toHaveLength(2)
  const first = await get('/controllers?limit=1')
  expect(first.status).toBe(200)
  expect(first.body).toMatchObject({ version: '4', controllers: [{ contractId: prefixed(41), scopes: 7, suspended: true, admittedAtBlockHeight: 15, admissionVersion: '2' }] })
  expect(first.body.nextCursor).toEqual(expect.any(String))
  expect((await get(`/controllers?limit=1&cursor=${first.body.nextCursor}`)).body).toMatchObject({ controllers: [{ contractId: prefixed(42), scopes: 1, suspended: false }], nextCursor: null })
})
it('preserves suspension across removal and re-admission and hides cleared tombstones', async () => {
  const entries = [...controllers(), envelope(receipt(18, [change(41, 5n, false, true), change(41, 6n, true, true)]))]
  let get = await serve(await load(entries))
  expect((await get('/controllers')).body.controllers).toMatchObject([
    { contractId: prefixed(41), admissionVersion: '6', suspended: true },
    { contractId: prefixed(42), suspended: false },
  ])
  entries.push(envelope(receipt(20, [change(41, 7n, false, true), [1, 'controller_suspension_changed', { controller: bytes(41), suspended: false, actor: { kind: 'Contract', bytes: bytes(50) }, version: 8n }]])))
  get = await serve(await load(entries))
  expect((await get('/controllers')).body).toMatchObject({ version: '8', controllers: [{ contractId: prefixed(42) }] })
})
function delegatedReceipt() {
  const r = { id: 'delegated', height: 18n, success: true, events: [] }
  const push = (emitter, topic, data) => r.events.push({ emitter: id(emitter), topic, ordinal: r.events.length, data })
  const begin = (who, path) => push(who, 'operation_begin', { op_seq: 1n, height: r.height, call_path: path.map(who => bytes(who)) })
  const end = (who, path) => push(who, 'operation_end', { op_seq: 1n, call_path: path.map(who => bytes(who)) })
  const effect = (who, topic, body) => push(who, topic, { version: 1, op_seq: 1n, body })
  const authority = who => ({ name: { ...rootName(), owner: bytes(who) }, previous_owner: bytes(10), previous_manager: bytes(11), actor: bytes(10), reason: 'Holder', data_cleared: false })
  begin(4, [4])
  effect(4, 'controller_used', { principal: { kind: 'Contract', bytes: bytes(10) }, via: bytes(41), scope: 1 })
  effect(4, 'authorities_changed', authority(20))
  // A callback has its own journal even at the same emitter and op_seq.
  begin(4, [4, 6, 4]); effect(4, 'authorities_changed', authority(21)); end(4, [4, 6, 4])
  end(4, [4])
  begin(4, [4]); effect(4, 'authorities_changed', authority(22)); end(4, [4])
  return r
}
it('attaches controller provenance only within its emitter, journal occurrence and op_seq', async () => {
  const r = delegatedReceipt(), entries = [...controllers(), envelope(r)]
  const get = await serve(await load(entries)), activity = (await get(`/activity?node=${rootNode}`)).body.activity
  const changes = activity.filter(e => e.eventType === 'authorities_changed')
  expect(changes).toHaveLength(3)
  expect(changes.find(e => e.data.name.owner[0] === 20)).toMatchObject({ via: prefixed(41), scope: 1, principal: { kind: 'Contract', bytes: bytes(10) } })
  for (const who of [21, 22]) expect(changes.find(e => e.data.name.owner[0] === who)).not.toHaveProperty('via')
  expect(activity.filter(e => e.eventType === 'controller_used')).toMatchObject([{ via: prefixed(41), node: rootNode }])
  r.events[1].reverted = true
  const reverted = await load([...controllers(), envelope(r)])
  expect(reverted.activityByNode.get(rootNode).some(e => e.via)).toBe(false)
})
function cession() {
  const a = { ...sample('Admission'), id: bytes(4), ordinal: 0, retiring: true, governance_version: 2n }
  const retire = [1, 'action_applied', { ...sample('ActionApplied'), action: { SetRetiring: { store: bytes(4), expected_version: 1n, value: true } }, config: directory().config, admission: a, market: null }]
  const root = rootName(), forward = { root: root.key.root, destination: bytes(8), destination_ordinal: 1, move_id: bytes(43), generation: 7n, completed_at: 2000n }
  const fresh = { ...root, incarnation: { generation: 8n, serial: 6n }, records: null, referrer: null, owner: bytes(20), manager: bytes(20), expires_at: 3000n, grace_end: 4000n }
  return { retire, forward, entries: [...createEventLog(), envelope(receipt(15, [admission('store', 8), retire])),
    envelope(receipt(2000, [[4, 'root_ceded', { forward, counters, grace_end: 2000n }], [8, 'root_registered', { ...registered(fresh), previous_generation: 7n }]]))] }
}
it.each(['event-log', 'sqlite'])('follows a cession and retains its history without old descendants or records from %s', async mode => {
  const c = cession(), get = await serve(await load(c.entries, mode))
  const name = (await get(`/name?node=${rootNode}`)).body
  expect(name).toMatchObject({ homeShard: prefixed(8), generation: '8', owner: prefixed(20), forwarding: [{ source: prefixed(4), destination: prefixed(8), moveId: prefixed(43) }] })
  expect((await get('/resolve?name=aurora')).body).toMatchObject({ homeShard: prefixed(8), generation: '8' })
  expect((await get(`/subname?node=${childNode}`)).body).toBeNull()
  expect((await get(`/records?node=${rootNode}`)).body.records).toEqual([])
  expect((await get(`/activity?node=${rootNode}`)).body.activity.filter(e => e.eventType === 'root_ceded')).toMatchObject([{ contractId: prefixed(4), data: { grace_end: '2000', forward: { destination: bytes(8) } } }])
})
it('collects all new topics and treats SetRetiring as a store admission update', () => {
  for (const topic of ['controller_changed', 'controller_suspension_changed']) expect(topicsFor('directory')).toContain(topic)
  expect(topicsFor('directory')).not.toContain('controller_approval_changed')
  for (const topic of ['controller_used', 'root_ceded']) expect(topicsFor('store')).toContain(topic)
  expect(admissions(receipt(15, [cession().retire]), { [id(1)]: 'directory', [id(4)]: 'store' }, id(1))).toMatchObject([{ role: 'store', id: id(4) }])
})
