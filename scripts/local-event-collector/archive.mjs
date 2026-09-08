import assert from 'node:assert/strict'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { dataDrivers } from '@dusk/w3sper'
import { normalizeObservedEvent } from '../indexer-operator/event-decoder.mjs'
import { parseEventLog } from '../../server/local-indexer/event-log.mjs'
import { summarizeEventLogText } from './cursor-summary.mjs'

export const archiveSource = 'rusk-finalized-archive'
const pollMs = 5_000
const batchSize = 100

export async function queryArchive(nodeUrl, query, fetcher = fetch) {
  const response = await fetcher(new URL('on/graphql/query', nodeUrl.endsWith('/') ? nodeUrl : nodeUrl + '/'), {
    method: 'POST', body: query, signal: AbortSignal.timeout(20_000),
  })
  assert(response.ok, `Archive HTTP ${response.status}`)
  const body = await response.json()
  assert(!body.errors, `Archive query failed: ${JSON.stringify(body.errors)}`)
  return body.data ?? body
}

export async function collectArchive(config, { signal, fetcher = fetch } = {}) {
  integer(config.fromBlock)
  assert(config.fromBlock > 0, '--from-block must be positive')
  const query = text => queryArchive(config.nodeUrl, text, fetcher)
  const contracts = new Map()
  for (const contract of config.contracts) {
    const driver = await dataDrivers.load(await readFile(resolve(config.publicDir, contract.driverFile)))
    driver.init()
    assert(!contracts.has(contract.contractId), 'Duplicate collector contract ID')
    contracts.set(contract.contractId, { ...contract, driver })
  }
  const scope = JSON.stringify(config.contracts.map(c => [c.key, c.contractId]).sort())
  await mkdir(dirname(config.eventLog), { recursive: true })
  await mkdir(dirname(config.cursorFile), { recursive: true })
  let cursor = config.truncate ? null : await readOptionalJson(config.cursorFile)
  const journal = await open(config.eventLog, 'a+')
  try {
    if (config.truncate) {
      await journal.truncate(0)
      await journal.sync()
      cursor = null
    }
    const size = (await journal.stat()).size
    if (cursor) {
      assert.equal(cursor.source, archiveSource, 'Legacy live log: use NEW journal/cursor/SQLite paths for archive replay')
      assert.equal(cursor.version, 2, 'Unsupported archive cursor version')
      assert.equal(cursor.scope, scope, 'Collector contract scope changed; use new journal/cursor paths')
      assert.equal(cursor.fromBlock, config.fromBlock, 'Collector --from-block changed')
      integer(cursor.eventLogBytes)
      integer(cursor.scannedBlockHeight)
      assert(cursor.eventLogBytes <= size, 'Journal is shorter than its committed cursor')
      // ponytail: restart reads the journal in memory, like the API; stream it if retention outgrows RAM.
      const committed = (await readFile(config.eventLog)).subarray(0, cursor.eventLogBytes).toString('utf8')
      const parsed = parseEventLog(committed)
      assert.equal(parsed.warnings.length, 0, 'Committed journal is corrupt')
      assert.equal(parsed.entries.length, cursor.eventCount, 'Journal/cursor event count mismatch')
      assert(!committed || committed.endsWith('\n'), 'Cursor splits a journal row')
    } else {
      assert.equal(size, 0, 'Unbound/legacy journal: use NEW journal/cursor/SQLite paths for archive replay')
      cursor = { ...summarizeEventLogText(''), version: 2, source: archiveSource, scope,
        fromBlock: config.fromBlock, scannedBlockHeight: config.fromBlock - 1, scannedBlockHash: null,
        eventLogBytes: 0, startedAt: new Date().toISOString() }
    }
    const anchor = (await query(`{block(height:${cursor.scannedBlockHeight}){header{height hash}}}`)).block?.header
    assert(anchor && anchor.height === cursor.scannedBlockHeight, 'Committed cursor block is unavailable')
    hexHash(anchor.hash)
    assert(!cursor.scannedBlockHash || cursor.scannedBlockHash === anchor.hash, 'Committed block hash changed; refusing to mix chains')
    cursor.scannedBlockHash = anchor.hash
    // A crash can leave appended bytes without a committed cursor. Roll back only that suffix, then refetch it.
    await journal.truncate(cursor.eventLogBytes)
    await journal.sync()
    await syncDirectory(dirname(config.eventLog))
    const replayedEventCount = cursor.eventCount
    await persist({ ...cursor, replayedEventCount, status: 'catching-up', reason: null })
    while (!signal?.aborted) {
      try {
        const pair = (await query('{lastBlockPair{json}}')).lastBlockPair?.json
        const [currentBlockHeight] = pair?.last_block ?? []
        const [finalizedHeight, finalizedHash] = pair?.last_finalized_block ?? []
        integer(currentBlockHeight)
        integer(finalizedHeight)
        hexHash(finalizedHash)
        assert(finalizedHeight <= currentBlockHeight && finalizedHeight >= cursor.scannedBlockHeight, 'Finalized head is behind the committed cursor')
        const to = Math.min(finalizedHeight, cursor.scannedBlockHeight + batchSize)
        const entries = []
        let scannedBlockHash = cursor.scannedBlockHash
        if (to > cursor.scannedBlockHeight) {
          const from = cursor.scannedBlockHeight + 1
          const blocks = (await query(`{blocks(range:[${from},${to}]){header{height hash prevBlockHash timestamp}}}`)).blocks
          assert(Array.isArray(blocks) && blocks.length === to - from + 1, 'Incomplete block range')
          for (const [i, block] of blocks.entries()) {
            assert.equal(block.header?.height, from + i, 'Out-of-order block range')
            hexHash(block.header.hash)
            integer(block.header.timestamp)
            assert.equal(block.header.prevBlockHash, i ? blocks[i - 1].header.hash : scannedBlockHash, 'Broken block hash chain')
          }
          scannedBlockHash = blocks.at(-1).header.hash
          if (to === finalizedHeight) assert.equal(scannedBlockHash, finalizedHash, 'Finalized head hash mismatch')
          const batches = await query('{' + blocks.map(({ header }, i) => `b${i}:contractEventBatch(hash:"${header.hash}"){blockHash complete json}`).join(' ') + '}')
          for (const [i, { header }] of blocks.entries()) {
            const batch = batches[`b${i}`]
            assert(batch?.complete === true && batch.blockHash === header.hash && Array.isArray(batch.json), `Archive batch unavailable/incomplete at ${header.height}`)
            for (const [eventIndex, raw] of batch.json.entries()) {
              hexHash(raw.source)
              const contract = contracts.get(raw.source)
              if (!contract) continue
              assert.equal(typeof raw.reverted, 'boolean', 'Archive event lacks rollback metadata')
              if (raw.reverted) continue
              assert(contract.events.includes(raw.topic), `Unsupported ${contract.key} event: ${raw.topic}`)
              hexHash(raw.origin)
              assert(typeof raw.data === 'string' && /^(?:[0-9a-f]{2})*$/i.test(raw.data), 'Invalid archive event bytes')
              const event = contract.driver.decodeEvent(raw.topic, Buffer.from(raw.data, 'hex'))
              const entry = normalizeObservedEvent({ contract, eventName: raw.topic, event,
                observedAt: new Date(header.timestamp * 1_000).toISOString(), observedBlockHeight: header.height })
              assert(entry, `Undecoded ${contract.key} event: ${raw.topic}`)
              Object.assign(entry.meta, { source: archiveSource, timeSource: 'block', blockHeight: header.height,
                blockHash: header.hash, txId: raw.origin, eventIndex, eventId: header.hash + ':' + eventIndex })
              entries.push(entry)
            }
          }
        } else {
          assert.equal(scannedBlockHash, finalizedHash, 'Finalized head hash mismatch')
        }
        const text = entries.map(entry => JSON.stringify(entry) + '\n').join('')
        if (text) {
          await journal.writeFile(text)
          await journal.sync()
        }
        const last = entries.at(-1)
        await persist({ ...cursor, currentBlockHeight, scannedBlockHeight: to, scannedBlockHash,
          eventCount: cursor.eventCount + entries.length, eventLogBytes: cursor.eventLogBytes + Buffer.byteLength(text),
          ...(last ? { lastEventAt: last.meta.observedAt, lastContract: last.meta.contractKey,
            lastEventName: last.event.type, lastTxId: last.meta.txId, lastBlockHeight: last.meta.blockHeight } : {}),
          status: to === finalizedHeight ? 'running' : 'catching-up', reason: null })
        if (to < finalizedHeight) continue
      } catch (error) {
        // Never advance past a missing archive, invalid payload, or failed durable write.
        await journal.truncate(cursor.eventLogBytes)
        await journal.sync()
        await persist({ ...cursor, status: 'blocked', reason: error.message })
        console.error(error.message)
      }
      try { await sleep(pollMs, undefined, { signal }) } catch (error) { if (!signal?.aborted) throw error }
    }
    await persist({ ...cursor, status: 'stopped' })
  } finally {
    await journal.close()
  }

  async function persist(next) {
    next.updatedAt = new Date().toISOString()
    const temporary = config.cursorFile + '.tmp'
    const file = await open(temporary, 'w')
    try { await file.writeFile(JSON.stringify(next, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    await rename(temporary, config.cursorFile)
    // Once published, error recovery must retain this cursor's journal prefix.
    cursor = next
    await syncDirectory(dirname(config.cursorFile))
  }
}

async function syncDirectory(path) {
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
function integer(value) {
  assert(Number.isSafeInteger(value) && value >= 0, 'Invalid archive integer')
}
function hexHash(value) {
  assert(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'Invalid archive hash')
}
async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; return null }
}
