import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hex, launchPolicyConfig } from '@duskdomains/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { bytes, createEventLog, directory, envelope, prefixed, receipt, registered, makeName, counters, rootNode, vaultEvents }
  from '../../scripts/test-fixtures/frozen-events.mjs'
import { deploymentReceipt, initializationEntry, policyDeployment, replacementConfig, setPolicy }
  from '../../scripts/test-fixtures/policy-replacement.mjs'
import { loadEventLogStore, loadSqliteStore } from '../local-indexer.mjs'
import { startServer, writeEventLog, writeSnapshot } from '../local-indexer-test-helpers.mjs'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { loadSnapshotStore } from './snapshot.mjs'

const servers = [], indexers = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const i of indexers.splice(0)) i.close()
})

const replacement = policyDeployment()
const launchPrices = launchPolicyConfig().annual_lux
const head = 22

// Launch history, a vault receipt under the launch policy, then the fee change: the new policy
// deployed at 19 and selected at 20. The collector journals its deployment after admission.
function replacedLog(...extra) {
  return [...createEventLog(), vaultEvents(), envelope(receipt(20, [setPolicy(20, replacement)])), initializationEntry(replacement), ...extra]
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

describe('a policy replaced after launch', () => {
  it.each(modes)('serves its config, prices, rates, lists and open state as soon as SetPolicy executes (%s)', async mode => {
    const store = await open(mode, replacedLog())
    const read = await serve(store)
    const published = mode === 'incremental' ? await store() : store
    expect(published.warnings).toEqual([])
    const fees = (await read('/fee-config')).body
    expect(fees.policy).toEqual({ contractId: `0x${replacement.policy}`, version: '2', config: {
      ...replacementConfig(), config_version: '1' } })
    expect(fees).toMatchObject({ threeCharYearLux: '200000000000', fourCharYearLux: '80000000000', fivePlusYearLux: '20000000000',
      premiumStartLux: '2000000000000000', referralRewardBps: 1500, premiumReferralRewardBps: 500, registrationsPaused: false, version: '2' })
    expect(fees.admissions[replacement.policy]).toMatchObject({ code_hash: [...Buffer.from(replacement.codeHash, 'hex')],
      init_hash: [...Buffer.from(replacement.initHash, 'hex')], admitted_at: '20' })
    const search = async q => (await read(`/search?query=${q}`)).body
    expect(await search('fresh')).toMatchObject({ status: 'available', price: 20, transactionBlocked: false, policy: fees.policy })
    expect(await search('four')).toMatchObject({ status: 'available', price: 80 })
    expect(await search('abc')).toMatchObject({ status: 'available', price: 200 })
    // Labels only the new policy reserves carry the same reason as launch reservations.
    expect(await search('newreserved')).toMatchObject({ status: 'reserved', transactionBlocked: true,
      issues: [{ tone: 'warning', text: 'Reserved by the registration policy.' }],
      reserved: { label: 'newreserved', reason: 'Reserved by the registration policy.' } })
    expect(await search('ab')).toMatchObject({ status: 'invalid', price: 0, transactionBlocked: true })
    expect(await search('spam')).toMatchObject({ status: 'invalid', transactionBlocked: true })
    expect(await search('explorer')).toMatchObject({ status: 'available', price: 20 }) // reserved only at launch
    const health = (await read('/health')).body
    expect(health).toMatchObject({ ok: true, pause: { registrationsPaused: false } })
    expect(health.deployment.contracts.policy.contractIds).toEqual([prefixed(3), `0x${replacement.policy}`])
  })

  it('keeps the launch policy history and renewal schedule, and follows a later renewal change on its own', async () => {
    const later = makeName('later.dusk')
    const registeredLater = { ...registered(later), policy: [...Buffer.from(replacement.policy, 'hex')], policy_version: 2n,
      policy_config_version: 1n, fee_lux: '20000000000', referral_lux: '3000000000' }
    const renewal = directory().config
    renewal.registration = { ...renewal.registration, policy: [...Buffer.from(replacement.policy, 'hex')], policy_version: 2n, revision: 22n }
    renewal.revision = 22n
    renewal.renewal = { version: 2n, effective_at: 22n, annual_lux: ['300000000000', '300000000000', '300000000000', '60000000000', '12000000000'], referral_bps: 800 }
    const read = await serve(await open('event-log', replacedLog(
      envelope(receipt(21, [[4, 'root_registered', registeredLater], [4, 'root_counters_changed', { root: later.key.root, counters }]])))))
    const before = (await read('/fee-config')).body
    expect(before.renewalSchedule).toEqual({ version: '1', effective_at: '1', annual_lux: launchPrices, referral_bps: 1000 })
    expect(before.renewalReferralRewardBps).toBe(1000)
    // The launch registration keeps the launch policy, version and fee; the new one records the new policy.
    const launch = (await read(`/activity?node=${rootNode}`)).body.activity.find(row => row.eventType === 'root_registered')
    expect(launch.data).toMatchObject({ policy: bytes(3), policy_version: '1', policy_config_version: '1', fee_lux: '10000000000' })
    const node = `0x${hex(later.key.node)}`
    expect((await read(`/activity?node=${node}`)).body.activity.find(row => row.eventType === 'root_registered').data)
      .toMatchObject({ policy: [...Buffer.from(replacement.policy, 'hex')], policy_version: '2', fee_lux: '20000000000' })
    expect((await read('/treasury')).body).toMatchObject({ registrationReceivedLux: '10000000000', totalReceivedLux: '10000000000' })
    expect(before.admissions[hex(bytes(3))]).toBeDefined()
    // Renewal pricing changes only through the directory schedule.
    const read2 = await serve(await open('event-log', replacedLog(envelope(receipt(22, [[1, 'action_applied', { id: { operator_epoch: 1n, nonce: 22n },
      action: { SetRenewal: { expected_version: 1n, annual_lux: renewal.renewal.annual_lux, referral_bps: 800 } }, config: renewal, admission: null, market: null }]])))))
    const after = (await read2('/fee-config')).body
    expect(after.renewalSchedule).toEqual({ version: '2', effective_at: '22', annual_lux: renewal.renewal.annual_lux, referral_bps: 800 })
    expect(after.renewalReferralRewardBps).toBe(800)
    expect(after.policy).toEqual(before.policy)
    expect(after.threeCharYearLux).toBe('200000000000')
  })

  it('serves the launch policy again when governance re-selects it with its genesis evidence, and not otherwise', async () => {
    const launch = { policy: hex(bytes(3)), codeHash: hex(bytes(7)), initHash: hex(bytes(7)) } // the fixture's genesis admission
    const read = await serve(await open('event-log', replacedLog(envelope(receipt(21, [setPolicy(21, launch, { policyVersion: 3n })])))))
    expect((await read('/fee-config')).body).toMatchObject({ policy: { contractId: prefixed(3), version: '3', config: { annual_lux: launchPrices } },
      threeCharYearLux: launchPrices[2], referralRewardBps: 2000, registrationsPaused: false })
    expect((await read('/search?query=explorer')).body).toMatchObject({ status: 'reserved' })
    const other = { ...launch, initHash: hex(bytes(67)) }
    const read2 = await serve(await open('event-log', replacedLog(envelope(receipt(21, [setPolicy(21, other, { policyVersion: 3n })])))))
    expect((await read2('/fee-config')).body).toMatchObject({ policy: { contractId: prefixed(3), version: '3', config: null },
      threeCharYearLux: null, registrationsPaused: true })
  })

  it('prices short roots from the policy tiers and keeps names held under the launch policy registered', async () => {
    const strict = policyDeployment({ config: replacementConfig({ minimum_root_bytes: 2, denied: ['aurora', 'spam'] }), wasm: 'short roots' })
    const read = await serve(await open('event-log', [...createEventLog(), envelope(receipt(20, [setPolicy(20, strict)])), initializationEntry(strict)]))
    expect((await read('/search?query=ab')).body).toMatchObject({ status: 'available', price: 400, transactionBlocked: false })
    expect((await read('/search?query=a')).body).toMatchObject({ status: 'invalid', price: 0 })
    // aurora.dusk was registered at launch: a later denial or minimum does not unregister it.
    expect((await read('/search?query=aurora')).body).toMatchObject({ status: 'registered' })
    const raised = policyDeployment({ config: replacementConfig({ minimum_root_bytes: 7 }), wasm: 'long roots' })
    const read2 = await serve(await open('event-log', [...createEventLog(), envelope(receipt(20, [setPolicy(20, raised)])), initializationEntry(raised)]))
    expect((await read2('/search?query=aurora')).body).toMatchObject({ status: 'registered' })
    expect((await read2('/search?query=sixsix')).body).toMatchObject({ status: 'invalid', transactionBlocked: true })
  })

  it('serves an initialization appended later to a running incremental SQLite store', async () => {
    // The collector catches up a missing initialization at its committed block; the running API applies the tail.
    const file = await writeEventLog([...createEventLog(), envelope(receipt(20, [setPolicy(20, replacement)]))])
    const cursorFile = await commitJournal(file, { scannedBlockHeight: 21, currentBlockHeight: 21 })
    const provider = await createIncrementalSqliteStore({ file: join(dirname(file), 'tail.sqlite'), eventLogFile: file, cursorFile })
    indexers.push(provider.indexer)
    expect((await provider()).feeConfig.policy.config).toBeNull()
    const applied = provider.indexer.stats.appliedEvents
    await appendFile(file, JSON.stringify(initializationEntry(replacement, { journaledAt: 22 })) + '\n')
    await commitJournal(file, { scannedBlockHeight: 22, currentBlockHeight: 22 }, cursorFile)
    const store = await provider()
    expect(store.warnings).toEqual([])
    expect(store.feeConfig).toMatchObject({ threeCharYearLux: '200000000000', registrationsPaused: false })
    expect(provider.indexer.stats.appliedEvents).toBe(applied + 1)
  })

  it('serves identical results from the event log, SQLite, incremental SQLite and a snapshot of that publication', async () => {
    const readers = Object.fromEntries(await Promise.all(modes.map(async mode => [mode, await serve(await open(mode, replacedLog()))])))
    const fees = (await readers['event-log']('/fee-config')).body, health = (await readers['event-log']('/health')).body
    readers.snapshot = await serve(await loadSnapshotStore(await writeSnapshot({ feeConfig: fees,
      poolState: { registrationsPaused: fees.registrationsPaused }, marketplaceConfig: { tradingPaused: health.pause.tradingPaused },
      cursor: { lastBlockHeight: head } })))
    const paths = ['/fee-config', ...['fresh', 'four', 'abc', 'ab', 'newreserved', 'wallet', 'explorer', 'spam'].map(q => `/search?query=${q}`)]
    for (const path of paths) {
      const expected = await readers['event-log'](path)
      expect(expected.status, path).toBe(200)
      for (const mode of ['sqlite', 'incremental', 'snapshot']) expect(await readers[mode](path), `${mode} ${path}`).toEqual(expected)
    }
    for (const mode of ['sqlite', 'incremental', 'snapshot']) expect((await readers[mode]('/health')).body.pause).toEqual(health.pause)
    for (const path of ['/activity?node=' + rootNode, '/names?owner=' + prefixed(10), '/treasury', '/search?query=aurora'])
      for (const mode of ['sqlite', 'incremental']) expect(await readers[mode](path), `${mode} ${path}`).toEqual(await readers['event-log'](path))
  })
})

describe('initializations that must not be served', () => {
  const blocked = async (entries, message) => {
    const store = await loadEventLogStore(...await written(entries))
    expect(store.warnings.map(w => w.message).join('\n')).toMatch(message)
    expect((await (await serve(store))('/fee-config')).status).toBe(503)
  }
  const written = async entries => {
    const file = await writeEventLog(entries)
    return [file, await commitJournal(file, { scannedBlockHeight: head, currentBlockHeight: head })]
  }

  it('rejects an initialization for a policy that governance never admitted', async () => {
    await blocked([...createEventLog(), initializationEntry(replacement)], /not admitted/)
  })

  it('rejects a deployment receipt emitted by another contract', async () => {
    const forged = deploymentReceipt(19, replacement)
    forged.events[1] = { ...forged.events[1], emitter: hex(bytes(77)) }
    await blocked([...createEventLog(), envelope(receipt(20, [setPolicy(20, replacement)])), initializationEntry(replacement, { receipt: forged })],
      /another emitter/)
  })

  it.each([
    ['init hash', { initHash: policyDeployment({ config: replacementConfig({ base_referral_bps: 3000 }) }).initHash }, {}, /init archive differs/],
    ['code hash', { codeHash: hex(bytes(66)) }, {}, /code hash differs/],
    ['binding', {}, { binding: { directory: bytes(1), vault: bytes(99), network: 1 } }, /binding differs/],
    ['deployment after admission', {}, { deployedAt: 21 }, /precede its admission/],
  ])('rejects a mismatched %s', async (_label, admission, change, message) => {
    let d = replacement, options = {}
    if (change.binding) d = policyDeployment({ bind: change.binding })
    if (change.deployedAt) options = { deployedAt: change.deployedAt, journaledAt: 21 }
    await blocked([...createEventLog(), envelope(receipt(20, [setPolicy(20, d, admission)])), initializationEntry(d, options)], message)
  })

  it('serves an authenticated policy only while its current admission pins the same evidence', async () => {
    const wrong = { initHash: policyDeployment({ config: replacementConfig({ base_referral_bps: 3000 }) }).initHash }
    const reselect = (height, policyVersion, overrides = {}) => envelope(receipt(height, [setPolicy(height, replacement, { policyVersion, ...overrides })]))
    const fees = async entries => (await (await serve(await loadEventLogStore(...await written(entries))))('/fee-config')).body
    // Re-admitted with a different init hash: fail closed. Re-admitted with the reviewed evidence: served again.
    expect(await fees(replacedLog(reselect(21, 3n, wrong)))).toMatchObject({ policy: { version: '3', config: null },
      threeCharYearLux: null, registrationsPaused: true })
    expect(await fees(replacedLog(reselect(21, 3n, wrong), reselect(22, 4n)))).toMatchObject({ policy: { version: '4' },
      threeCharYearLux: '200000000000', registrationsPaused: false })
  })

  it('never serves an admitted policy without its authenticated deployment initialization', async () => {
    // A conforming policy initializes only at deployment; an in-scope event after admission is not that evidence.
    const late = envelope(deploymentReceipt(21, replacement, { ...replacement.args, config: replacementConfig({ annual_lux: Array(5).fill('1') }) }))
    for (const entries of [[envelope(receipt(20, [setPolicy(20, replacement)]))], [envelope(receipt(20, [setPolicy(20, replacement)])), late]]) {
      const store = await loadEventLogStore(...await written([...createEventLog(), ...entries]))
      expect(store.warnings).toEqual([])
      const read = await serve(store), fees = (await read('/fee-config')).body
      expect(fees).toMatchObject({ policy: { contractId: `0x${replacement.policy}`, version: '2', config: null },
        threeCharYearLux: null, fourCharYearLux: null, fivePlusYearLux: null, registrationsPaused: true,
        renewalSchedule: { version: '1', referral_bps: 1000 } })
      expect((await read('/search?query=fresh')).body).toMatchObject({ price: null, transactionBlocked: true })
      expect((await read('/search?query=aurora')).body).toMatchObject({ status: 'registered' })
    }
  })
})
