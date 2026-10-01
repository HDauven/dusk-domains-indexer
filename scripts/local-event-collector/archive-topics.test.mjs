import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, vi } from 'vitest'
import { duskDomainsContractEventTopics } from '@duskdomains/sdk/event-catalog'
import { collectArchive } from './archive.mjs'
import { loadEventLogStore } from '../../server/local-indexer.mjs'
import { expectJson, startServer } from '../../server/local-indexer-test-helpers.mjs'

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }))
vi.mock('@dusk/w3sper', () => ({ dataDrivers: { load: async () => ({
  init() {}, decodeEvent: (_topic, bytes) => JSON.parse(Buffer.from(bytes).toString()),
}) } }))

const hash = n => n.toString(16).padStart(64, '0')
const core = hash(900)
const rawEvent = (topic, data = 'ff', source = core) => ({
  source, origin: hash(901), reverted: false, topic, data,
})
const cleared = rawEvent('record_cleared', Buffer.from(JSON.stringify({
  node: Array(32).fill(1), controller: Array(32).fill(2), key: 'website',
})).toString('hex'))

it.each(['event-batch', 'finalized-block'])('skips retired core topics and advances coverage using %s', async archiveApi => {
  const retired = ['core_referral_config_changed', 'fee_config_updated', 'subname_delegated', 'subname_revoked']
  // Retired payloads are deliberately undecodable by the current driver.
  const events = new Map(retired.map((topic, i) => [i + 1, [rawEvent(topic)]]))
  events.get(1).push(cleared)
  const result = await collectTopics(archiveApi, events)
  assert.equal(result.cursor.status, 'running')
  assert.equal(result.cursor.reason, null)
  assert.equal(result.cursor.scannedBlockHeight, 4)
  assert.equal(result.cursor.scannedBlockHash, hash(4))
  assert.equal(result.cursor.eventCount, 1)
  assert.deepEqual(result.rows.map(row => [row.event.type, row.meta.blockHeight, row.meta.eventIndex]), [
    ['record_cleared', 1, 1],
  ])
  assert.equal(result.health.ok, true)
  assert.equal(result.health.finalizedBlockHeight, 4)
})

it.each(['event-batch', 'finalized-block'])('blocks unknown topics with upgrade guidance and exposes the stall in health using %s', async archiveApi => {
  const message = 'Unsupported core event `unknown_event` at block 2: upgrade the indexer'
  const result = await collectTopics(archiveApi, new Map([[1, [cleared]], [2, [rawEvent('unknown_event')]]]))
  assert.equal(result.cursor.reason, message)
  assert.equal(result.cursor.status, 'blocked')
  assert.equal(result.cursor.scannedBlockHeight, 1)
  assert.equal(result.cursor.eventCount, 1)
  assert.equal(result.rows.length, 1)
  assert.equal(result.health.ok, false)
  assert.equal(result.health.cursor.status, 'blocked')
  assert.equal(result.health.finalizedBlockHeight, 1)
  assert.equal(result.health.degradedReason.code, 'archive_not_caught_up')
  assert(result.logs.some(log => log.degradedReason?.message === message && log.cursor?.reason === message))
})

it.each(['event-batch', 'finalized-block'])('still blocks malformed supported events using %s', async archiveApi => {
  const result = await collectTopics(archiveApi, new Map([[1, [cleared]], [2, [rawEvent('record_cleared')]]]))
  assert.equal(result.cursor.status, 'blocked')
  assert(result.cursor.reason)
  assert(!result.cursor.reason.includes('Unsupported'))
  assert.equal(result.cursor.scannedBlockHeight, 1)
  assert.equal(result.rows.length, 1)
  assert.equal(result.health.ok, false)
  assert.equal(result.health.cursor.status, 'blocked')
})

it('does not skip a core-only retired topic emitted by a configured treasury', async () => {
  const result = await collectTopics('event-batch', new Map([[1, [cleared]], [2, [rawEvent('core_referral_config_changed', 'ff', hash(902))]]]))
  assert.equal(result.cursor.reason, 'Unsupported treasury event `core_referral_config_changed` at block 2: upgrade the indexer')
  assert.equal(result.cursor.scannedBlockHeight, 1)
  assert.equal(result.health.ok, false)
})

async function collectTopics(archiveApi, events) {
  const dir = await mkdtemp(join(tmpdir(), 'archive-topics-'))
  const config = { fromBlock: 1, nodeUrl: 'http://node/', publicDir: dir,
    eventLog: join(dir, 'events.jsonl'), cursorFile: join(dir, 'cursor.json'),
    contracts: [
      { key: 'core', contractId: core, driverFile: 'driver.wasm', events: duskDomainsContractEventTopics.core },
      { key: 'treasury', contractId: hash(902), driverFile: 'driver.wasm', events: duskDomainsContractEventTopics.treasury },
    ] }
  await writeFile(join(dir, 'driver.wasm'), '')
  const controller = new AbortController()
  const logs = []
  const logger = { warn: value => logs.push(value), error: value => logs.push(value) }
  const server = await startServer(() => loadEventLogStore(config.eventLog, config.cursorFile), { logger })
  const header = height => ({ height, hash: hash(height), prevBlockHash: hash(height - 1), timestamp: 1_780_000_000 + height })
  let polls = 0
  let result
  const fetcher = async (_url, { body }) => {
    let data
    if (body.includes('__type')) data = { __type: { fields: [{ name: archiveApi === 'event-batch' ? 'contractEventBatch' : 'checkBlock' }] } }
    else if (body.includes('lastBlockPair')) {
      const head = ++polls === 1 ? 1 : events.size
      if (polls === 3) {
        controller.abort()
        result = { cursor: JSON.parse(await readFile(config.cursorFile)),
          rows: (await readFile(config.eventLog, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
          health: await expectJson(`${server.baseUrl}/health`), logs }
      }
      data = { lastBlockPair: { json: { last_block: [head, hash(head)], last_finalized_block: [head, hash(head)] } } }
    } else if (body.includes('block(height:')) data = { block: { header: header(Number(body.match(/height:(\d+)/)[1])) } }
    else if (body.includes('blocks(range:')) {
      const [, start, end] = body.match(/\[(\d+),(\d+)\]/).map(Number)
      data = { blocks: Array.from({ length: end - start + 1 }, (_, i) => ({ header: header(start + i), transactions: [{ id: hash(901) }] })) }
    } else if (body.includes('checkBlock')) {
      data = Object.fromEntries([...body.matchAll(/(b\d+):checkBlock/g)].map(([, alias]) => [alias, true]))
    } else {
      data = Object.fromEntries([...body.matchAll(/(b\d+):contractEvent(?:Batch|s)\(hash:"([0-9a-f]+)"\)/g)]
        .map(([, alias, blockHash]) => [alias, { blockHash, complete: true, json: events.get(parseInt(blockHash, 16)) ?? [] }]))
    }
    return { ok: true, json: async () => data }
  }
  try {
    await collectArchive(config, { signal: controller.signal, fetcher })
    return result
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
}
