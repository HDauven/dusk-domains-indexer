import { afterEach, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { emptyFrozenView } from './frozen-view.mjs'
import { loadEventLogStore, loadSqliteStore } from '../local-indexer.mjs'
import { startServer, writeEventLog } from '../local-indexer-test-helpers.mjs'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { createEventLog, directory, envelope, receipt, sample, bytes, id, prefixed } from '../../scripts/test-fixtures/frozen-events.mjs'

const servers = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
async function get(store, path) {
  const server = await startServer(store); servers.push(server)
  const response = await fetch(server.baseUrl + path)
  return { status: response.status, body: await response.json() }
}
it('has no per-authority approval projection', () => {
  expect(emptyFrozenView()).not.toHaveProperty('controllerApprovalsByAuthority')
})
it.each(['', `?authority=${prefixed(10)}`])('removes the approval route before loading state: %s', async query => {
  let reads = 0
  const result = await get(() => { reads++; return emptyFrozenView() }, '/controller-approvals' + query)
  expect(result.status).toBe(404)
  expect(reads).toBe(0)
})
it.each(['event-log', 'sqlite'])('serves current governance versions through fee-config after %s replay and reopen', async mode => {
  const config = { ...directory().config, recipient_version: 9007199254740993n }
  const admission = { ...sample('Admission'), id: bytes(4), governance_version: 9007199254740993n, accepts_moves: false }
  const entries = [...createEventLog(), envelope(receipt(15, [[1, 'action_applied', {
    ...sample('ActionApplied'), action: { SetAcceptsMoves: { store: bytes(4), expected_version: 9007199254740992n, value: false } }, admission, config, market: null,
  }]])), envelope(receipt(16, [[1, 'operator_changed', {
    ...sample('OperatorChanged'), previous: config.operator, current: config.operator, operator_epoch: config.operator_epoch + 1n, recipient_version: 9007199254740994n,
  }]]))]
  const file = await writeEventLog(entries), cursorFile = await commitJournal(file)
  const load = () => mode === 'sqlite' ? loadSqliteStore(join(dirname(file), 'governance.sqlite'), { eventLogFile: file, cursorFile }) : loadEventLogStore(file, cursorFile)
  for (let reopen = 0; reopen < 2; reopen++) {
    const store = await load()
    expect(store.warnings).toEqual([])
    expect(store).not.toHaveProperty('controllerApprovalsByAuthority')
    expect(store.admissions[id(4)].governance_version).toBe('9007199254740993')
    expect(store.directory.recipient_version).toBe('9007199254740994')
    const result = await get(store, '/fee-config')
    expect(result.status).toBe(200)
    expect(result.body.directory.recipient_version).toBe('9007199254740994')
    expect(result.body.admissions[id(4)]).toMatchObject({ governance_version: '9007199254740993', accepts_moves: false })
  }
})
