import assert from 'node:assert/strict'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { dataDrivers } from '@dusk/w3sper'
import { duskDomainsRetiredContractEventTopics } from '@duskdomains/sdk/event-catalog'
import { normalizeObservedEvent } from '@duskdomains/sdk/projection'
import { parseEventLog } from '../../server/local-indexer/event-log.mjs'
import { summarizeEventLogText } from './cursor-summary.mjs'

export const archiveSource = 'rusk-finalized-archive'
const pollMs = 5_000
const batchSize = 100

export async function queryArchive(nodeUrl, query, fetcher = fetch, { signal, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(20_000)
    const response = await fetcher(new URL('on/graphql/query', nodeUrl.endsWith('/') ? nodeUrl : nodeUrl + '/'), {
      method: 'POST', body: query, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if ((response.status === 429 || response.status >= 500 && response.status <= 599) && attempt < 6) {
      const retryAfter = response.headers?.get('retry-after')
      const retryMs = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0
      await response.body?.cancel()
      await wait(Math.max(Math.min(1000 * 2 ** attempt, 30_000), retryMs), undefined, { signal })
      continue
    }
    assert(response.ok, `Archive HTTP ${response.status}`)
    const body = await response.json()
    assert(!body.errors, `Archive query failed: ${JSON.stringify(body.errors)}`)
    return body.data ?? body
  }
}

export async function collectArchive(config, { signal, fetcher = fetch, wait = sleep } = {}) {
  integer(config.fromBlock)
  assert(config.fromBlock > 0, '--from-block must be positive')
  const query = text => queryArchive(config.nodeUrl, text, fetcher, { signal, wait })
  const contracts = new Map()
  for (const contract of config.contracts) {
    const driver = await dataDrivers.load(await readFile(resolve(config.publicDir, contract.driverFile)))
    driver.init()
    assert(!contracts.has(contract.contractId), 'Duplicate collector contract ID')
    contracts.set(contract.contractId, { ...contract, driver })
  }
  const scope = JSON.stringify(config.contracts.map(c => [c.key, c.contractId]).sort())
  // Contract pools (ADR 0002 in dusk-domains-protocol) grow: the router adds registries that emit the
  // core's events. Follow each one from the router event that adds it, which always comes first.
  const registry = config.contracts.find(contract => contract.key === 'core')
  const followPoolMember = entry => {
    if (!registry || entry?.meta?.contractKey !== 'router' || entry.event?.type !== 'pool_member_added') return
    if (entry.event.kind !== 'registry') return
    const contractId = String(entry.event.member).toLowerCase().replace(/^0x/, '')
    hexHash(contractId)
    if (!contracts.has(contractId)) contracts.set(contractId, { ...contracts.get(registry.contractId), contractId })
  }
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
      for (const entry of parsed.entries) followPoolMember(entry)
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
    const archiveApi = await detectArchiveApi(query)
    await persist({ ...cursor, archiveApi, replayedEventCount, status: 'catching-up', reason: null })
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
        let scannedBlockHeight = cursor.scannedBlockHeight
        let scannedBlockHash = cursor.scannedBlockHash
        if (to > scannedBlockHeight) {
          const from = scannedBlockHeight + 1
          const fields = archiveApi === 'event-batch' ? '' : ' transactions{id}'
          const blocks = (await query(`{blocks(range:[${from},${to}]){header{height hash prevBlockHash timestamp}${fields}}}`)).blocks
          assert(Array.isArray(blocks) && blocks.length === to - from + 1, 'Incomplete block range')
          for (const [i, block] of blocks.entries()) {
            assert.equal(block.header?.height, from + i, 'Out-of-order block range')
            hexHash(block.header.hash)
            integer(block.header.timestamp)
            assert.equal(block.header.prevBlockHash, i ? blocks[i - 1].header.hash : scannedBlockHash, 'Broken block hash chain')
          }
          if (to === finalizedHeight) assert.equal(blocks.at(-1).header.hash, finalizedHash, 'Finalized head hash mismatch')
          const batches = archiveApi === 'event-batch' ? await eventBatches(query, blocks) : await finalizedBlockEvents(query, blocks)
          for (const [i, events] of batches.entries()) {
            const { header } = blocks[i]
            for (const [eventIndex, raw] of events.entries()) {
              hexHash(raw.source)
              const contract = contracts.get(raw.source)
              if (!contract) continue
              assert.equal(typeof raw.reverted, 'boolean', 'Archive event lacks rollback metadata')
              if (raw.reverted) continue
              if (duskDomainsRetiredContractEventTopics[contract.key]?.includes(raw.topic)) continue
              assert(contract.events.includes(raw.topic), `Unsupported ${contract.key} event \`${raw.topic}\` at block ${header.height}: upgrade the indexer`)
              hexHash(raw.origin)
              assert(typeof raw.data === 'string' && /^(?:[0-9a-f]{2})*$/i.test(raw.data), 'Invalid archive event bytes')
              const event = contract.driver.decodeEvent(raw.topic, Buffer.from(raw.data, 'hex'))
              const entry = normalizeObservedEvent({ contract, eventName: raw.topic, event,
                observedAt: new Date(header.timestamp * 1_000).toISOString(), observedBlockHeight: header.height })
              assert(entry, `Undecoded ${contract.key} event: ${raw.topic}`)
              Object.assign(entry.meta, { source: archiveSource, timeSource: 'block', blockHeight: header.height,
                blockHash: header.hash, txId: raw.origin, eventIndex, eventId: header.hash + ':' + eventIndex })
              entries.push(entry)
              followPoolMember(entry)
            }
          }
          if (batches.length) ({ height: scannedBlockHeight, hash: scannedBlockHash } = blocks[batches.length - 1].header)
        } else {
          assert.equal(scannedBlockHash, finalizedHash, 'Finalized head hash mismatch')
        }
        const text = entries.map(entry => JSON.stringify(entry) + '\n').join('')
        if (text) {
          await journal.writeFile(text)
          await journal.sync()
        }
        const last = entries.at(-1)
        await persist({ ...cursor, currentBlockHeight, scannedBlockHeight, scannedBlockHash,
          eventCount: cursor.eventCount + entries.length, eventLogBytes: cursor.eventLogBytes + Buffer.byteLength(text),
          ...(last ? { lastEventAt: last.meta.observedAt, lastContract: last.meta.contractKey,
            lastEventName: last.event.type, lastTxId: last.meta.txId, lastBlockHeight: last.meta.blockHeight } : {}),
          status: scannedBlockHeight === finalizedHeight ? 'running' : 'catching-up',
          reason: scannedBlockHeight < to ? `Archive has not finalized block ${scannedBlockHeight + 1} yet` : null })
        if (scannedBlockHeight < finalizedHeight && scannedBlockHeight === to) continue
      } catch (error) {
        // Never advance past a missing archive, invalid payload, or failed durable write.
        await journal.truncate(cursor.eventLogBytes)
        await journal.sync()
        await persist({ ...cursor, status: 'blocked', reason: error.message })
        console.error(error.message)
      }
      try { await wait(pollMs, undefined, { signal }) } catch (error) { if (!signal?.aborted) throw error }
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

// rusk-private #290 adds contractEventBatch; Rusk 1.7 releases predate it.
async function detectArchiveApi(query) {
  const fields = (await query('{__type(name:"Query"){fields{name}}}')).__type?.fields ?? []
  return fields.some(field => field.name === 'contractEventBatch') ? 'event-batch' : 'finalized-block'
}

async function eventBatches(query, blocks) {
  const batches = await query('{' + blocks.map(({ header }, i) => `b${i}:contractEventBatch(hash:"${header.hash}"){blockHash complete json}`).join(' ') + '}')
  return blocks.map(({ header }, i) => {
    const batch = batches[`b${i}`]
    assert(batch?.complete === true && batch.blockHash === header.hash && Array.isArray(batch.json), `Archive batch unavailable/incomplete at ${header.height}`)
    return batch.json
  })
}

// Without contractEventBatch, an empty contractEvents list can also mean the archive lacks the block.
// Rusk 1.7 writes a block's finalized marker and its events in one transaction, so read events only
// for the leading blocks checkBlock confirms. Finalizing regroups events by transaction hash; put them
// back in the block's transaction order, with block-level events (rewards, slashes) last. Slashes
// run first in Rusk 1.7, so their block's eventIndex values differ from contractEventBatch's.
async function finalizedBlockEvents(query, blocks) {
  const aliased = (list, field) => '{' + list.map(({ header }, i) => `b${i}:${field(header)}`).join(' ') + '}'
  const checks = await query(aliased(blocks, ({ height, hash }) => `checkBlock(height:${height},hash:"${hash}",onlyFinalized:true)`))
  const missing = blocks.findIndex((_, i) => checks[`b${i}`] !== true)
  const archived = missing === -1 ? blocks : blocks.slice(0, missing)
  if (!archived.length) return []
  const events = await query(aliased(archived, ({ hash }) => `contractEvents(hash:"${hash}"){json}`))
  return archived.map(({ header, transactions }, i) => {
    const json = events[`b${i}`]?.json
    assert(Array.isArray(json) && Array.isArray(transactions), `Archive events unavailable at ${header.height}`)
    const position = new Map(transactions.map(({ id }, index) => [id, index]))
    for (const { origin } of json) assert(position.has(origin) || origin === header.hash, `Archive event from unknown origin at ${header.height}`)
    return json.toSorted((a, b) => (position.get(a.origin) ?? position.size) - (position.get(b.origin) ?? position.size))
  })
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
