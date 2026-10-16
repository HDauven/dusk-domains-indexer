// A fake Rusk 1.7.1 finalized archive (no contractEventBatch), shaped like the testnet and mainnet
// nodes: every block rewards its generator with a block-level stake event whose origin is the
// block hash; a transaction's events carry its ID as origin, and a failed one keeps its fee event;
// `transactions` lists every executed transaction; the header's `txRoot` is zero only without
// transactions; `contractEvents` answers in finalized order, grouped by origin hash. A field is
// answered only when the query selects it.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJson, stringifyJson } from '@duskdomains/sdk'
import { collectArchive } from '../local-event-collector/archive.mjs'
import { marketCandidatesFile } from '../local-event-collector/candidates-file.mjs'
import { topicsFor } from '../local-event-collector/frozen.mjs'
import { decodeReceipt } from '../../server/local-indexer/receipt-codec.mjs'
import { id, moveHistory, projectionOptions } from './frozen-events.mjs'

export const hash = n => n.toString(16).padStart(64, '0')
export const heights = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
export const stakeContract = '02' + '00'.repeat(31)
export const transferContract = '01' + '00'.repeat(31)
export const emptyTxRoot = '0'.repeat(64)
export const rawEvent = (source, topic, origin, { data = '00', reverted = false } = {}) => ({ source, topic, origin, data, reverted })

/**
 * The move fixture's receipts, at blocks 1, 10, 11, 12, 14, 15 (two admissions), 20-23 and 30, and
 * around them a failed transaction that only paid its fee (5), one beside a receipt of ours (12),
 * one whose own events reverted (25), a transaction of another contract (7) and an out-of-scope
 * contract configuring itself as a market (26). Every other block holds no transaction.
 */
export function exampleChain() {
  const m = moveHistory(), chain = chainOf([...m.events, m.final])
  const fee = origin => rawEvent(transferContract, 'moonlight', origin)
  addTransaction(chain, 5, { id: hash(20005), err: 'Panic: out of gas', events: [fee(hash(20005))] })
  addTransaction(chain, 7, { id: hash(20007), err: null, events: [rawEvent(id(77), 'transfer', hash(20007)), fee(hash(20007))] })
  addTransaction(chain, 12, { id: hash(20012), err: 'Panic: denied', events: [fee(hash(20012))] })
  addTransaction(chain, 25, { id: hash(20025), err: 'Panic: expired', events: [rawEvent(id(4), 'root_registered', hash(20025), { reverted: true }), fee(hash(20025))] })
  addTransaction(chain, 26, { id: hash(20026), err: null, events: [rawEvent(id(78), 'market_configured', hash(20026)), fee(hash(20026))] })
  return chain
}

/** Height → transactions, one per journal receipt, each also paying its fee as Rusk does. */
export function chainOf(entries) {
  const chain = new Map()
  for (const [index, entry] of entries.entries()) {
    const r = decodeReceipt(entry.event.receipt), origin = hash(10000 + index)
    addTransaction(chain, Number(r.height), { id: origin, err: null, events: [...r.events.map(e => rawEvent(e.emitter, e.topic, origin,
      { data: Buffer.from(stringifyJson(e.data)).toString('hex'), reverted: e.reverted ?? false })), rawEvent(transferContract, 'moonlight', origin)] })
  }
  return chain
}

export function addTransaction(chain, height, transaction) {
  if (!chain.has(height)) chain.set(height, [])
  chain.get(height).push(transaction)
  return chain
}

export function finalizedArchive(chain, { head, api = 'finalized-block' } = {}) {
  // `overrides` rewrite a block as `blocks` answers it; `unfinalized` heights fail checkBlock;
  // `faults` answer the first query they match instead of the archive; `hideTxRoot` answers
  // headers without `txRoot`, so the collector reads every block's events.
  const state = { head, unfinalized: new Set(), overrides: new Map(), prevBlockHash: new Map(), anchorHash: new Map(),
    finalizedHash: null, hideTxRoot: false, faults: [], queries: [] }
  const transactionsAt = height => chain.get(height) ?? []
  const header = (height, body) => ({ height, hash: hash(height), prevBlockHash: state.prevBlockHash.get(height) ?? hash(height - 1),
    timestamp: 1791374400 + height,
    ...(body.includes('txRoot') && !state.hideTxRoot ? { txRoot: transactionsAt(height).length ? hash(0xab0000 + height) : emptyTxRoot } : {}) })
  const block = (height, body) => {
    const value = { header: header(height, body), ...(body.includes('transactions') ? { transactions: transactionsAt(height).map(({ id }) => ({ id })) } : {}) }
    state.overrides.get(height)?.(value)
    return value
  }
  const reward = height => rawEvent(stakeContract, 'reward', hash(height))
  // Finalization regroups a block's events by origin hash, keeping their order within each origin.
  const finalizedEvents = height => [...transactionsAt(height).map(t => [t.id, t.events]), [hash(height), [reward(height)]]]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([, events]) => structuredClone(events))
  const reply = data => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data }) })
  const fetcher = async (_url, { body }) => {
    state.queries.push(body)
    const fault = state.faults.findIndex(f => f.matches(body))
    if (fault !== -1) return state.faults.splice(fault, 1)[0].response
    if (body.includes('__type')) return reply({ __type: { fields: [{ name: api === 'event-batch' ? 'contractEventBatch' : 'checkBlock' }] } })
    if (body.includes('lastBlockPair')) return reply({ lastBlockPair: { json: { last_block: [state.head + 2, hash(state.head + 2)],
      last_finalized_block: [state.head, state.finalizedHash ?? hash(state.head)] } } })
    if (body.includes('block(height:')) {
      const height = Number(body.match(/height:(\d+)/)[1])
      return reply({ block: { header: { ...header(height, body), ...(state.anchorHash.has(height) ? { hash: state.anchorHash.get(height) } : {}) } } })
    }
    if (body.includes('blocks(range:')) {
      const [, from, to] = body.match(/\[(\d+),(\d+)\]/).map(Number)
      // Rusk 1.7.1 MAX_GRAPHQL_BLOCKS_PER_QUERY.
      if (to - from + 1 > 200) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ errors: [{ message: 'range too large (max 200 blocks)' }] }) }
      return reply({ blocks: Array.from({ length: to - from + 1 }, (_, i) => block(from + i, body)) })
    }
    if (body.includes('checkBlock')) return reply(Object.fromEntries([...body.matchAll(/(b\d+):checkBlock\(height:(\d+),hash:"([0-9a-f]+)",onlyFinalized:true\)/g)]
      .map(([, alias, n, h]) => [alias, Number(n) <= state.head && h === hash(Number(n)) && !state.unfinalized.has(Number(n))])))
    if (body.includes('contractEventBatch')) return reply(Object.fromEntries([...body.matchAll(/(b\d+):contractEventBatch\(hash:"([0-9a-f]+)"\)/g)]
      .map(([, alias, h]) => [alias, { blockHash: h, complete: true, json: [...transactionsAt(parseInt(h, 16)).flatMap(t => structuredClone(t.events)), reward(parseInt(h, 16))] }])))
    if (body.includes('contractEvents')) return reply(Object.fromEntries([...body.matchAll(/(b\d+):contractEvents\(hash:"([0-9a-f]+)"\)/g)]
      .map(([, alias, h]) => [alias, { json: finalizedEvents(parseInt(h, 16)) }])))
    throw new Error(`Unexpected archive query ${body}`)
  }
  const heights = pattern => state.queries.flatMap(q => [...q.matchAll(pattern)].map(m => parseInt(m[1], 16)))
  return {
    state, fetcher,
    /** Heights whose events were read, in request order. */
    eventReads: () => heights(/contractEvent(?:Batch|s)\(hash:"([0-9a-f]+)"\)/g),
    /** Heights checkBlock was asked about, in request order. */
    checks: () => state.queries.flatMap(q => [...q.matchAll(/checkBlock\(height:(\d+)/g)].map(m => Number(m[1]))),
    /** Each `blocks(range:)` request as [from, to]. */
    ranges: () => state.queries.filter(q => q.includes('blocks(range:')).map(q => q.match(/\[(\d+),(\d+)\]/).slice(1).map(Number)),
    /** Heights holding at least one transaction, up to `to`. */
    withTransactions: (to = state.head) => [...chain.keys()].filter(h => h <= to && transactionsAt(h).length).sort((a, b) => a - b),
  }
}

/** A collector config for the frozen fixture scope, writing into a fresh directory. */
export async function collectorConfig(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'collector-load-'))
  await writeFile(join(dir, 'driver.wasm'), '')
  return { dir, config: { fromBlock: 1, eventSchemaVersion: '1', chainId: 'dusk:1', nodeUrl: 'http://node.invalid/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: Object.entries(projectionOptions.contracts).map(([contractId, key]) => ({ key, contractId, driverFile: 'driver.wasm', events: topicsFor(key) })),
    ...overrides } }
}

// Archive events here are JSON, as in the other collector tests.
export const jsonDriver = async () => ({ decodeEvent: (_topic, data) => parseJson(data.toString()) })

/**
 * Run the collector until it has waited the 5 s poll interval `polls` times. Every wait is
 * recorded with the cursor it saw; `onWait` may change the archive, or `stop()` the run there.
 * Returns the waits, the cursor as the last wait saw it and the cursor the stopped run left.
 */
export async function collect(archive, config, { polls = 1, onWait } = {}) {
  const controller = new AbortController(), waits = []
  let polled = 0, cursor = null
  await collectArchive(config, { signal: controller.signal, fetcher: archive.fetcher, loadDriver: jsonDriver,
    wait: async ms => {
      cursor = JSON.parse(await readFile(config.cursorFile, 'utf8'))
      waits.push({ ms, status: cursor.status, scanned: cursor.scannedBlockHeight })
      await onWait?.({ ms, cursor, waits, stop: () => controller.abort() })
      if (ms === 5_000 && ++polled >= polls) controller.abort()
    } })
  return { waits, cursor, final: JSON.parse(await readFile(config.cursorFile, 'utf8')) }
}

/**
 * What collection left: the journal, the market candidate journal and the cursor, without clock
 * times and without what the last start replayed from the journal (`replayedEventCount`).
 */
export async function collected(config) {
  const read = path => readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
  const { startedAt, updatedAt, replayedEventCount, ...cursor } = JSON.parse(await read(config.cursorFile))
  return { journal: await read(config.eventLog), candidates: await read(marketCandidatesFile(config.cursorFile)), cursor }
}
