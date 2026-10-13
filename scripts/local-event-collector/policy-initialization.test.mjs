import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blake3 } from '@noble/hashes/blake3.js'
import { fromHex, hex, parseJson, stringifyJson } from '@duskdomains/sdk'
import { collectArchive, linkedHash } from './archive.mjs'
import { topicsFor } from './frozen.mjs'
import { deploymentContractId, fetchPolicyInitialization, parseDeployTransaction } from './deployment.mjs'
import { deploymentInitialization, initializationHash } from '../../server/local-indexer/policy-initialization.mjs'
import { decodeReceipt } from '../../server/local-indexer/receipt-codec.mjs'
import { loadEventLogStore } from '../../server/local-indexer/event-log-store.mjs'
import { startServer } from '../../server/local-indexer-test-helpers.mjs'
import { createEventLog, envelope, receipt, projectionOptions, bytes, counters, makeName, registered } from '../test-fixtures/frozen-events.mjs'
import { deployTransactionHex, deployTx, deploymentReceipt, policyDeployment, policyDriver, recordedDeployment, replacementConfig, setPolicy }
  from '../test-fixtures/policy-replacement.mjs'

const dirs = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('a real Rusk 1.7.1 policy deployment', () => {
  const recorded = recordedDeployment, r = recorded.responses
  const admission = recorded.admission
  const query = async text => {
    if (text.includes('finalizedEvents(')) return { finalizedEvents: { json: { ...r.finalizedEvents, events: r.finalizedEvents.events.slice(0, 1) } } }
    if (text.includes('tx(hash:')) return { tx: structuredClone(r.tx) }
    if (text.includes('blocks(range:')) return { blocks: [structuredClone(r.block)] }
    throw new Error(`Unexpected archive query ${text}`)
  }
  // The collector's verified chain has the recorded block at 142.
  const canonicalHash = async height => {
    expect(height).toBe(142)
    return r.block.header.hash
  }
  const fetchReal = (overrides = {}) => fetchPolicyInitialization({ query, blockEvents: async () => r.contractEvents, canonicalHash,
    policy: recorded.policy, admission, admittedAt: BigInt(recorded.manifest.directoryDeploymentHeight), driver: policyDriver,
    directoryId: hex(recorded.binding.directory), vaultId: hex(recorded.binding.vault), ...overrides })

  it('parses the Boreas deployment and derives the release manifest\'s contract ID, code hash and init hash', () => {
    const deploy = parseDeployTransaction(r.tx.tx.raw)
    expect(deploy).toMatchObject({ chainId: recorded.binding.network, deployNonce: BigInt(recorded.manifest.deployNonce) })
    expect(hex(deploy.owner)).toBe(recorded.manifest.deploymentOwner)
    expect(deploymentContractId(deploy)).toBe(recorded.policy)
    expect(hex(blake3(deploy.bytecode))).toBe(recorded.manifest.codeHash)
    expect(deploy.bytecodeHash).toBe(recorded.manifest.codeHash)
    expect(initializationHash(deploy.initArgs)).toBe(recorded.manifest.initHash)
    expect([hex(admission.code_hash), hex(admission.init_hash)]).toEqual([recorded.manifest.codeHash, recorded.manifest.initHash])
    expect(() => parseDeployTransaction(r.tx.tx.raw.slice(0, -2))).toThrow(/signature length/)
    expect(() => parseDeployTransaction('00' + r.tx.tx.raw.slice(4))).toThrow(/not a Moonlight/)
    expect(() => parseDeployTransaction('0303' + r.tx.tx.raw.slice(4))).toThrow(/Boreas/)
  })

  it.each([
    ['an Aegis (tag 1)', { boreas: false }],
    ['a Boreas', {}],
    ['a separate receiver and refund key', { receiver: true, refund: true }],
  ])('parses %s deployment of a policy', (_label, options) => {
    const d = policyDeployment()
    const deploy = parseDeployTransaction(deployTransactionHex(d, options))
    expect(deploymentContractId(deploy)).toBe(d.policy)
    expect([hex(deploy.initArgs), deploy.deployNonce, hex(deploy.owner)]).toEqual([hex(d.archive), 7n, hex(d.owner)])
  })

  it('authenticates its initialization journal against the admission', async () => {
    const result = await fetchReal()
    expect(result.rejected).toBeUndefined()
    expect(result.initialization).toEqual({ role: 'policy', contractId: recorded.policy, transaction: r.tx.id, blockHeight: 142,
      blockHash: r.block.header.hash, codeHash: recorded.manifest.codeHash, initArchive: expect.stringMatching(/^[0-9a-f]{1664}$/),
      deployNonce: recorded.manifest.deployNonce, deploymentOwner: recorded.manifest.deploymentOwner })
    expect(initializationHash(fromHex(result.initialization.initArchive))).toBe(recorded.manifest.initHash)
    expect(result.receipt.events.map(e => [e.topic, e.ordinal])).toEqual([['operation_begin', 0], ['policy_initialized', 1], ['operation_end', 2]])
    const args = deploymentInitialization(result.receipt, recorded.policy)
    expect(args.config).toMatchObject({ minimum_root_bytes: 3, base_referral_bps: 2000, annual_lux: ['150000000000', '150000000000', '150000000000', '50000000000', '10000000000'] })
    expect(args.config.reserved).toHaveLength(60)
  })

  it.each([
    ['init_hash_mismatch', { admission: { ...admission, init_hash: Array(32).fill(1) } }],
    ['code_hash_mismatch', { admission: { ...admission, code_hash: Array(32).fill(1) } }],
    ['initialization_after_admission', { admittedAt: 141n }],
    ['binding_mismatch', { directoryId: hex(Array(32).fill(1)) }],
  ])('rejects %s', async (code, overrides) => {
    expect((await fetchReal(overrides)).rejected?.code).toBe(code)
  })

  it('fails closed on a deployment event the reviewed driver cannot decode', async () => {
    const events = structuredClone(r.contractEvents)
    events[1].data = 'ff'
    expect((await fetchReal({ blockEvents: async () => events })).rejected?.code).toBe('initialization_receipt_invalid')
  })

  it.each([
    ['a failed deployment', tx => { tx.err = 'Panic' }],
    ['another contract', tx => { tx.tx.contractId = hex(Array(32).fill(2)) }],
    ['a call', tx => { tx.tx.isDeploy = false }],
  ])('rejects %s as the deployment', async (_label, change) => {
    const tx = structuredClone(r.tx); change(tx)
    const result = await fetchReal({ query: async text => text.includes('tx(hash:') ? { tx } : query(text) })
    expect(result.rejected?.code).toBe('deployment_mismatch')
  })

  it('reports a transaction the node cannot find as unavailable, to retry', async () => {
    const result = await fetchReal({ query: async text => text.includes('tx(hash:') ? { tx: null } : query(text) })
    expect(result.rejected?.code).toBe('deployment_not_found')
  })

  // Contract IDs don't bind init arguments: an orphan deployment of the same ID can carry the admitted
  // init while the canonical one carries another. Only the collected chain's block counts.
  it('rejects the deployment when the collected chain has another block at its height, although its init matches', async () => {
    const result = await fetchReal({ canonicalHash: async () => 'ab'.repeat(32) })
    expect(result.rejected?.code).toBe('deployment_not_canonical')
    expect(result.initialization).toBeUndefined()
  })

  it.each([
    ['an archive block other than the collected chain\'s', block => { block.header.hash = 'ab'.repeat(32) }, 'deployment_not_canonical'],
    ['a block that does not list the deployment transaction', block => { block.transactions = [{ id: 'cd'.repeat(32) }] }, 'deployment_not_included'],
  ])('rejects %s', async (_label, change, code) => {
    const block = structuredClone(r.block); change(block)
    const result = await fetchReal({ query: async text => text.includes('blocks(range:') ? { blocks: [block] } : query(text) })
    expect(result.rejected?.code).toBe(code)
  })

  it('rejects a deployment transaction the node places in another block', async () => {
    const tx = structuredClone(r.tx); tx.blockHash = 'ab'.repeat(32)
    const result = await fetchReal({ query: async text => text.includes('tx(hash:') ? { tx } : query(text) })
    expect(result.rejected?.code).toBe('deployment_not_canonical')
  })
})

// A fake finalized archive: the launch journal, then block 19 deploys the replacement policy and
// optionally an unadmitted contract that also emits a policy initialization, and block 20 executes SetPolicy.
const hash = n => n.toString(16).padStart(64, '0')
const header = height => ({ height, hash: hash(height), prevBlockHash: hash(height - 1), timestamp: 1791374400 + height })
// A block at the same height that the chain did not keep.
const orphanHash = height => 'e'.repeat(8) + hash(height).slice(8)
const canonicalTx = hash(30000)
const rawData = data => Buffer.from(stringifyJson(data)).toString('hex')
function deployEvents(d, args = d.args, origin = deployTx, height = 19) {
  return [...deploymentReceipt(height, d, args, origin).events.map(e => ({ source: d.policy, topic: e.topic, reverted: false, origin, data: rawData(e.data) })),
    { source: '01' + '00'.repeat(31), topic: 'moonlight', reverted: false, origin, data: '00' }]
}
// `orphan`: an inconsistent archive whose lookups place the admitted deployment in an orphan block at
// `deployedAt`, while the canonical block there deploys the same policy ID with other init arguments.
// `listed: false`: block transaction lists omit the deployment transaction.
async function harness({ api = 'finalized-block', admitted = policyDeployment(), admissionOverrides = {}, eventArgs, archive, intruder, deployedAt = 19,
  extra = [], orphan = false, listed = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'policy-archive-')); dirs.push(dir)
  await writeFile(join(dir, 'driver.wasm'), '')
  const config = { fromBlock: 1, eventSchemaVersion: '1', chainId: 'dusk:1', nodeUrl: 'http://node.invalid/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: Object.entries(projectionOptions.contracts).map(([contractId, key]) => ({ key, contractId, driverFile: 'driver.wasm', events: topicsFor(key) })) }
  const blocks = new Map(), transactions = new Map(), orphans = new Map()
  for (const [index, entry] of [...createEventLog(), envelope(receipt(20, [setPolicy(20, admitted, admissionOverrides)])), ...extra].entries()) {
    const r = decodeReceipt(entry.event.receipt), height = Number(r.height)
    if (!blocks.has(height)) blocks.set(height, [])
    blocks.get(height).push(...r.events.map(e => ({ source: e.emitter, topic: e.topic, reverted: false, origin: hash(10000 + index), data: rawData(e.data) })))
  }
  const deployments = [[admitted, deployTx, eventArgs ?? admitted.args, archive]]
  if (orphan) {
    const other = { ...admitted.args, config: replacementConfig({ annual_lux: Array(5).fill('1') }) }
    deployments[0] = [admitted, canonicalTx, other, policyDriver.encodeInput('init', stringifyJson(other))]
    orphans.set(orphanHash(deployedAt), deployEvents(admitted, admitted.args, deployTx, deployedAt))
    transactions.set(deployTx, { id: deployTx, blockHeight: deployedAt, blockHash: orphanHash(deployedAt), err: null, gasSpent: 1,
      tx: { id: deployTx, isDeploy: true, contractId: admitted.policy, raw: deployTransactionHex(admitted) } })
  }
  if (intruder) deployments.push([intruder, hash(20000), intruder.args])
  // Deployment transactions come first in their block, also when SetPolicy executes in that block.
  blocks.set(deployedAt, [...deployments.flatMap(([d, origin, args]) => deployEvents(d, args, origin, deployedAt)), ...(blocks.get(deployedAt) ?? [])])
  for (const [d, origin, , initArchive] of deployments)
    transactions.set(origin, { id: origin, blockHeight: deployedAt, blockHash: hash(deployedAt), err: null, gasSpent: 1,
      tx: { id: origin, isDeploy: true, contractId: d.policy, raw: deployTransactionHex(d, { archive: initArchive ?? d.archive }) } })
  let head = 20, failing = null, hideEvents = false, inconsistentRanges = false, answerOrphan = orphan, clock = Date.parse('2026-10-13T00:00:00.000Z')
  const queries = []
  const listing = events => [...new Set(events.map(e => e.origin))].filter(id => listed || id !== deployTx).map(id => ({ id }))
  // Each poll ends at the collector's wait; `between` runs before the next poll of the same process.
  async function run({ polls = 1, between } = {}) {
    const controller = new AbortController()
    let observed, waited = 0
    const fetcher = async (_url, { body }) => {
      queries.push(body)
      if (failing && body.includes(failing)) return { ok: true, json: async () => ({ errors: [{ message: `${failing} unavailable` }] }) }
      let result
      if (body.includes('__type')) result = { __type: { fields: [{ name: api === 'event-batch' ? 'contractEventBatch' : 'checkBlock' }] } }
      else if (body.includes('lastBlockPair')) result = { lastBlockPair: { json: { last_block: [head + 2, hash(head + 2)], last_finalized_block: [head, hash(head)] } } }
      else if (body.includes('finalizedEvents(')) {
        const id = body.match(/contractId:"([0-9a-f]+)"/)[1]
        const first = hideEvents ? null : answerOrphan && id === admitted.policy
          ? { ...orphans.get(orphanHash(deployedAt))[0], id: 1, block_height: deployedAt, block_hash: orphanHash(deployedAt) }
          : [...blocks].sort(([a], [b]) => a - b).flatMap(([n, events]) => events.filter(e => e.source === id)
            .map(e => ({ ...e, id: 1, block_height: n, block_hash: hash(n) })))[0]
        result = { finalizedEvents: { json: { events: first ? [first] : [], endCursor: null, startCursor: null, hasNextPage: false } } }
      } else if (body.includes('tx(hash:')) result = { tx: structuredClone(transactions.get(body.match(/hash:"([0-9a-f]+)"/)[1]) ?? null) }
      else if (body.includes('block(height:')) result = { block: { header: header(Number(body.match(/height:(\d+)/)[1])) } }
      else if (body.includes('blocks(range:')) {
        const [, start, end] = body.match(/\[(\d+),(\d+)\]/).map(Number)
        result = { blocks: Array.from({ length: end - start + 1 }, (_, i) => {
          const height = start + i
          // The orphan answers the single-block lookup, or with `inconsistentRanges` every range.
          if (answerOrphan && height === deployedAt && (start === end || inconsistentRanges))
            return { header: { ...header(height), hash: orphanHash(height) }, transactions: listing(orphans.get(orphanHash(height))) }
          return { header: header(height), transactions: listing(blocks.get(height) ?? []) }
        }) }
      } else if (body.includes('checkBlock')) result = Object.fromEntries([...body.matchAll(/(b\d+):checkBlock/g)].map(([, alias]) => [alias, true]))
      else result = Object.fromEntries([...body.matchAll(/(b\d+):contractEvent(?:Batch|s)\(hash:"([0-9a-f]+)"\)/g)].map(([, alias, blockHash]) =>
        [alias, { blockHash, complete: true, json: orphans.get(blockHash) ?? blocks.get(parseInt(blockHash, 16)) ?? [] }]))
      return { ok: true, json: async () => result }
    }
    await collectArchive(config, { signal: controller.signal, fetcher,
      // Archive events here are JSON; the init archive is encoded by the reviewed policy driver.
      loadDriver: async () => ({ decodeEvent: (_topic, data) => parseJson(data.toString()), encodeInput: (fn, json) => policyDriver.encodeInput(fn, json) }),
      now: () => clock,
      wait: async () => {
        observed = JSON.parse(await readFile(config.cursorFile))
        if (++waited >= polls) controller.abort()
        else await between?.(waited, observed)
      } })
    return observed
  }
  const rows = async () => (await readFile(config.eventLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const fees = async () => (await loadEventLogStore(config.eventLog, config.cursorFile)).feeConfig
  return { config, admitted, queries, run, rows, fees, setHead: n => { head = n }, fail: text => { failing = text }, hide: v => { hideEvents = v },
    inconsistent: v => { inconsistentRanges = v }, repair: () => { answerOrphan = false }, advance: ms => { clock += ms },
    located: (policy = '') => queries.filter(q => q.includes(`finalizedEvents(contractId:"${policy}`)).length }
}

describe('linking a deployment block to the collected chain', () => {
  const archiveOf = (headerAt = header) => {
    const asked = []
    const query = async text => {
      asked.push(text)
      const [, start, end] = text.match(/blocks\(range:\[(\d+),(\d+)\]\)/).map(Number)
      return { blocks: Array.from({ length: end - start + 1 }, (_, i) => ({ header: headerAt(start + i) })) }
    }
    return { query, asked }
  }

  it('answers a verified height directly and walks up to the nearest verified block in batches', async () => {
    const { query, asked } = archiveOf()
    expect(await linkedHash(query, 250, new Map([[250, hash(250)]]))).toBe(hash(250))
    expect(asked).toEqual([])
    expect(await linkedHash(query, 5, new Map([[3, hash(3)], [250, hash(250)], [900, hash(900)]]))).toBe(hash(5))
    expect(asked.map(q => q.match(/\[(\d+,\d+)\]/)[1])).toEqual(['5,104', '105,204', '205,250'])
  })

  it.each([
    ['breaks the hash chain at a batch boundary', height => height === 105 ? { ...header(height), prevBlockHash: orphanHash(104) } : header(height),
      /Block 105 does not link to block 104/],
    ['ends on another block than the verified one', height => height === 250 ? { ...header(height), hash: orphanHash(250) } : header(height),
      /does not link to the collected block at 250/],
  ])('throws when the archive %s', async (_label, headerAt, message) => {
    await expect(linkedHash(archiveOf(headerAt).query, 5, new Map([[250, hash(250)]]))).rejects.toThrow(message)
  })

  it('needs a verified block at or above the height', async () => {
    await expect(linkedHash(archiveOf().query, 5, new Map([[4, hash(4)]]))).rejects.toThrow(/No collected block at or above 5/)
  })
})

describe('collecting a policy replacement', () => {
  it.each(['finalized-block', 'event-batch'])('journals the deployment initialization right after SetPolicy, so the API serves it (%s)', async api => {
    const h = await harness({ api })
    expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 20, eventCount: 7,
      policyInitializations: { [h.admitted.policy]: { status: 'authenticated', transaction: deployTx, blockHeight: 19 } } })
    const rows = await h.rows(), row = rows.at(-1)
    expect(rows.at(-2).event.initialization).toBeUndefined()
    expect(row.meta).toMatchObject({ blockHeight: 20, blockHash: hash(20), txId: deployTx, eventId: `${hash(19)}:${deployTx}`, eventIndex: 0 })
    expect(row.event.initialization).toEqual({ role: 'policy', contractId: h.admitted.policy, transaction: deployTx, blockHeight: 19,
      blockHash: hash(19), codeHash: h.admitted.codeHash, initArchive: hex(h.admitted.archive), deployNonce: '7', deploymentOwner: hex(h.admitted.owner) })
    // The transfer contract's event in the same deployment transaction stays out of the receipt.
    expect(decodeReceipt(row.event.receipt).events.map(e => e.topic)).toEqual(['operation_begin', 'policy_initialized', 'operation_end'])
    const store = await loadEventLogStore(h.config.eventLog, h.config.cursorFile)
    expect(store.warnings).toEqual([])
    expect(store.feeConfig).toMatchObject({ threeCharYearLux: '200000000000', registrationsPaused: false, policy: { contractId: `0x${h.admitted.policy}`, version: '2' } })
    // A restart neither refetches nor duplicates it.
    const before = h.queries.length
    expect(await h.run()).toMatchObject({ eventCount: 7, scannedBlockHeight: 20 })
    expect(h.queries.slice(before).some(q => q.includes('finalizedEvents('))).toBe(false)
    expect(await h.rows()).toEqual(rows)
  })

  it('journals a policy deployed earlier in the block that executes SetPolicy', async () => {
    const h = await harness({ deployedAt: 20 })
    expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 20, eventCount: 7 })
    const row = (await h.rows()).at(-1)
    expect(row.meta.blockHeight).toBe(20)
    expect(row.event.initialization).toMatchObject({ blockHeight: 20, blockHash: hash(20) })
    expect((await h.fees()).threeCharYearLux).toBe('200000000000')
  })

  it('never journals an unadmitted contract that emits a policy initialization', async () => {
    const intruder = policyDeployment({ config: replacementConfig({ annual_lux: Array(5).fill('1') }), wasm: 'unadmitted' })
    const h = await harness({ intruder })
    await h.run()
    const initializations = (await h.rows()).filter(row => row.event.initialization)
    expect(initializations.map(row => row.event.initialization.contractId)).toEqual([h.admitted.policy])
    expect(h.queries.some(q => q.includes(intruder.policy))).toBe(false)
    expect((await h.fees()).threeCharYearLux).toBe('200000000000')
  })

  it.each([
    ['init_hash_mismatch', { admissionOverrides: { initHash: policyDeployment({ config: replacementConfig({ base_referral_bps: 3000 }) }).initHash } }],
    ['code_hash_mismatch', { admissionOverrides: { codeHash: hex(bytes(66)) } }],
    ['initialization_event_mismatch', { eventArgs: { ...policyDeployment().args, config: replacementConfig({ annual_lux: Array(5).fill('1') }) } }],
    ['init_hash_mismatch', { archive: policyDriver.encodeInput('init', stringifyJson({ ...policyDeployment().args, config: replacementConfig({ denied: [] }) })) }],
  ])('fails closed on %s without stopping collection', async (code, options) => {
    const h = await harness(options)
    // A fact about the chain is not asked again in the same run, however long it runs.
    const cursor = await h.run({ polls: 3, between: () => h.advance(24 * 3_600_000) })
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 20, eventCount: 6 })
    expect(cursor.policyInitializations[h.admitted.policy]).toMatchObject({ status: 'rejected', code, attempts: 1 })
    expect(cursor.policyInitializations[h.admitted.policy].retryAt).toBeUndefined()
    expect(h.located()).toBe(1)
    expect((await h.rows()).some(row => row.event.initialization)).toBe(false)
    const store = await loadEventLogStore(h.config.eventLog, h.config.cursorFile)
    expect(store.warnings).toEqual([])
    expect(store.feeConfig).toMatchObject({ policy: { config: null }, threeCharYearLux: null, registrationsPaused: true })
    expect(store.namesByCanonical.has('aurora.dusk')).toBe(true)
    // Public health keeps the status and code; the collector logs the detail.
    const server = await startServer(store)
    try {
      const health = await (await fetch(`${server.baseUrl}/health`)).json()
      expect(health.cursor.policyInitializations).toEqual({ [h.admitted.policy]: { status: 'rejected', code } })
    } finally { await server.close() }
  })

  it('asks again, in the same run, an archive that has not finalized the deployment yet', async () => {
    // Rusk can report a block final before finalizedEvents has it; deployment and SetPolicy can share that block.
    const h = await harness({ api: 'event-batch', deployedAt: 20 })
    h.hide(true)
    const cursor = await h.run({ polls: 3, between: async (poll, observed) => {
      if (poll === 1) {
        expect(observed.policyInitializations[h.admitted.policy]).toEqual({ status: 'rejected', code: 'initialization_not_found',
          message: expect.any(String), attempts: 1, retryAt: '2026-10-13T00:00:05.000Z' })
        h.hide(false); h.advance(4_000)
      } else h.advance(1_000)
    } })
    expect(h.located()).toBe(2)
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 20, eventCount: 7,
      policyInitializations: { [h.admitted.policy]: { status: 'authenticated', blockHeight: 20 } } })
    expect((await h.rows()).at(-1).meta.blockHeight).toBe(20)
    expect((await h.fees()).threeCharYearLux).toBe('200000000000')
  })

  it('authenticates a rejected policy again when governance re-admits it with the reviewed evidence', async () => {
    const d = policyDeployment(), wrong = policyDeployment({ config: replacementConfig({ base_referral_bps: 3000 }) }).initHash
    const h = await harness({ admitted: d, admissionOverrides: { initHash: wrong },
      extra: [envelope(receipt(21, [setPolicy(21, d, { policyVersion: 3n })]))] })
    h.setHead(21)
    expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 21, eventCount: 8,
      policyInitializations: { [d.policy]: { status: 'authenticated', blockHeight: 19 } } })
    const row = (await h.rows()).at(-1)
    expect([row.meta.blockHeight, row.event.initialization.contractId]).toEqual([21, d.policy])
    expect(await h.fees()).toMatchObject({ threeCharYearLux: '200000000000', policy: { version: '3' }, registrationsPaused: false })
  })

  it('catches up an admitted policy whose initialization was not journaled, at the committed block', async () => {
    // A journal written before this version (or while the archive lacked the events) holds only the admission.
    const h = await harness()
    h.hide(true)
    expect((await h.run()).policyInitializations[h.admitted.policy]).toMatchObject({ status: 'rejected', code: 'initialization_not_found' })
    expect((await h.fees()).policy.config).toBeNull()
    h.hide(false); h.setHead(25)
    expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 25, eventCount: 7 })
    const row = (await h.rows()).at(-1)
    expect(row.meta.blockHeight).toBe(20)
    expect(row.event.initialization.blockHeight).toBe(19)
    expect((await h.fees()).threeCharYearLux).toBe('200000000000')
  })

  // A lookup that throws (a failed query, a malformed answer, a block the archive can't serve) fails
  // closed for that policy only. A historical tx lookup can fail while current blocks stay readable.
  it('withholds only that policy while its lookups fail, keeps collecting, and asks again with backoff', async () => {
    const later = makeName('later.dusk'), h = await harness({ extra: [envelope(receipt(22, [[4, 'root_registered', registered(later)],
      [4, 'root_counters_changed', { root: later.key.root, counters }]]))] }), policy = h.admitted.policy
    h.setHead(22); h.fail('tx(hash:')
    const cursor = await h.run({ polls: 4, between: async (poll, observed) => {
      const status = observed.policyInitializations[policy]
      if (poll === 1) {
        // The admission and the later registration are journaled; only the initialization waits.
        expect(observed).toMatchObject({ status: 'running', reason: null, scannedBlockHeight: 22, eventCount: 7 })
        expect(status).toEqual({ status: 'rejected', code: 'lookup_failed', message: expect.stringContaining('tx(hash: unavailable'),
          attempts: 1, retryAt: '2026-10-13T00:00:05.000Z' })
        const store = await loadEventLogStore(h.config.eventLog, h.config.cursorFile)
        expect(store.warnings).toEqual([])
        expect(store.feeConfig).toMatchObject({ policy: { contractId: `0x${policy}`, config: null }, threeCharYearLux: null, registrationsPaused: true })
        expect(store.namesByCanonical.has('later.dusk')).toBe(true)
        h.advance(5_000)
      } else if (poll === 2) {
        expect(status).toMatchObject({ code: 'lookup_failed', attempts: 2, retryAt: '2026-10-13T00:00:25.000Z' })
        h.advance(10_000)
      } else {
        // Not asked again before its retry time.
        expect(status).toMatchObject({ attempts: 2 })
        h.fail(null); h.advance(10_000)
      }
    } })
    expect(h.located(policy)).toBe(3)
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 22, eventCount: 8,
      policyInitializations: { [policy]: { status: 'authenticated', blockHeight: 19 } } })
    const row = (await h.rows()).at(-1)
    expect([row.meta.blockHeight, row.event.initialization.blockHeight]).toEqual([22, 19])
    expect((await h.fees()).threeCharYearLux).toBe('200000000000')
  })

  it('authenticates and serves a later policy while an earlier admitted policy\'s lookups keep failing', async () => {
    const next = policyDeployment({ config: replacementConfig({ annual_lux: Array(5).fill('70000000000') }), wasm: 'next policy' })
    const h = await harness({ intruder: next, extra: [envelope(receipt(21, [setPolicy(21, next, { policyVersion: 3n })]))] })
    h.setHead(21); h.fail(`contractId:"${h.admitted.policy}"`)
    const cursor = await h.run()
    expect(cursor).toMatchObject({ status: 'running', reason: null, scannedBlockHeight: 21, eventCount: 8 })
    expect(cursor.policyInitializations).toMatchObject({
      [h.admitted.policy]: { status: 'rejected', code: 'lookup_failed', attempts: 1, retryAt: '2026-10-13T00:00:05.000Z' },
      [next.policy]: { status: 'authenticated', blockHeight: 19 } })
    expect(await h.fees()).toMatchObject({ policy: { contractId: `0x${next.policy}`, version: '3' }, threeCharYearLux: '70000000000',
      registrationsPaused: false })
  })

  // Contract IDs don't bind init arguments, so the deployment's block must be the collected chain's.
  it.each([20, 19])('rejects an orphan deployment at %i whose init matches the admission, and never serves the canonical one\'s other arguments', async deployedAt => {
    const h = await harness({ orphan: true, deployedAt }), policy = h.admitted.policy
    const cursor = await h.run({ polls: 2, between: (_poll, observed) => {
      expect(observed).toMatchObject({ status: 'running', scannedBlockHeight: 20, eventCount: 6 })
      expect(observed.policyInitializations[policy]).toMatchObject({ status: 'rejected', code: 'deployment_not_canonical', attempts: 1,
        retryAt: '2026-10-13T00:00:05.000Z' })
      // Asked again, a consistent archive names the canonical deployment, whose init the admission doesn't pin.
      h.repair(); h.advance(5_000)
    } })
    expect(cursor.policyInitializations[policy]).toMatchObject({ status: 'rejected', code: 'init_hash_mismatch', attempts: 2 })
    expect(cursor.policyInitializations[policy].retryAt).toBeUndefined()
    expect((await h.rows()).some(row => row.event.initialization)).toBe(false)
    expect(await h.fees()).toMatchObject({ policy: { config: null }, threeCharYearLux: null, registrationsPaused: true })
  })

  it('links a deployment below the scanned batch to the collected chain', async () => {
    const h = await harness({ deployedAt: 15 })
    h.setHead(17)
    expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 17, eventCount: 5 })
    h.setHead(20)
    const before = h.queries.length
    expect(await h.run()).toMatchObject({ status: 'running', scannedBlockHeight: 20, eventCount: 7,
      policyInitializations: { [h.admitted.policy]: { status: 'authenticated', blockHeight: 15 } } })
    // From the deployment up to the block this collector committed before the batch.
    expect(h.queries.slice(before).some(q => q.includes('blocks(range:[15,17])'))).toBe(true)
    expect((await h.rows()).at(-1).event.initialization).toMatchObject({ blockHeight: 15, blockHash: hash(15) })
    expect((await h.fees()).threeCharYearLux).toBe('200000000000')
  })

  it.each([
    ['answers its lookups from an orphan block', () => {}, 'deployment_not_canonical'],
    ['also serves the orphan in block ranges, which then don\'t link', h => h.inconsistent(true), 'lookup_failed'],
  ])('rejects a deployment below the scanned batch when the archive %s', async (_label, change, code) => {
    const h = await harness({ orphan: true, deployedAt: 15 })
    h.setHead(17)
    await h.run()
    h.setHead(20); change(h)
    const cursor = await h.run()
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 20, eventCount: 6 })
    expect(cursor.policyInitializations[h.admitted.policy]).toMatchObject({ status: 'rejected', code, attempts: 1, retryAt: expect.any(String) })
    expect((await h.fees()).policy.config).toBeNull()
  })

  it('rejects a deployment whose canonical block does not list its transaction', async () => {
    const h = await harness({ api: 'event-batch', listed: false })
    const cursor = await h.run()
    expect(cursor).toMatchObject({ status: 'running', scannedBlockHeight: 20, eventCount: 6 })
    expect(cursor.policyInitializations[h.admitted.policy]).toMatchObject({ status: 'rejected', code: 'deployment_not_included', retryAt: expect.any(String) })
    expect((await h.fees()).policy.config).toBeNull()
  })
})
