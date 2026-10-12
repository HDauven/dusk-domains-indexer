import assert from 'node:assert/strict'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { encodeReceipt, decodeReceipt as decodeStoredReceipt } from '../../server/local-indexer/receipt-codec.mjs'
import { loadDataDriver } from '@duskdomains/sdk'
import { decodeReceipt, followAdmissions, jsonSafe, policyAdmissions } from './frozen.mjs'
import { fetchPolicyInitialization, initializationRow, unavailableInitialization } from './deployment.mjs'
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

export async function collectArchive(config, { signal, fetcher = fetch, wait = sleep, loadDriver = loadDataDriver, now = Date.now } = {}) {
  integer(config.fromBlock)
  assert(config.fromBlock > 0, '--from-block must be positive')
  const query = text => queryArchive(config.nodeUrl, text, fetcher, { signal, wait })
  const contracts = new Map()
  for (const contract of config.contracts) {
    const driver = await loadDriver(await readFile(resolve(config.publicDir, contract.driverFile)))
    assert(!contracts.has(contract.contractId), 'Duplicate collector contract ID')
    contracts.set(contract.contractId, { ...contract, driver })
  }
  const directoryId = config.contracts.find(c => c.key === 'directory')?.contractId
  assert(directoryId, 'Frozen collector requires a directory')
  const vaultId = config.contracts.find(c => c.key === 'vault')?.contractId
  const projectionOptions = { directoryId, contracts: Object.fromEntries(config.contracts.map(c => [c.contractId, c.key])) }
  // Release-scoped policies journal their own initialization. Every later admitted policy
  // needs its deployment initialization journaled after the admitting receipt. `admitted` maps
  // each policy to its current admission and the collected block that admitted it.
  let policies = { admitted: new Map(), initialized: new Set(config.contracts.filter(c => c.key === 'policy').map(c => c.contractId)), status: new Map() }
  const admit = (a, height, hash) => policies.admitted.set(a.id, { admission: a.admission,
    block: Number.isSafeInteger(height) && /^[0-9a-f]{64}$/.test(hash ?? '') ? { height, hash } : null })
  // Deployment heights already linked to the collected chain; finalized blocks never change.
  const linked = new Map()
  const clonePolicies = p => ({ admitted: new Map(p.admitted), initialized: new Set(p.initialized), status: new Map(p.status) })
  // A rejection waits for its retry time, if it has one; a mismatch waits for a re-admission or restart.
  const pendingPolicies = () => [...policies.admitted.keys()].filter(id => {
    const status = policies.status.get(id)
    return !policies.initialized.has(id) && (status?.status !== 'rejected' || (status.retryAt && now() >= Date.parse(status.retryAt)))
  })
  const noteInitialization = initialization => {
    policies.initialized.add(initialization.contractId)
    policies.status.set(initialization.contractId, { status: 'authenticated', transaction: initialization.transaction, blockHeight: initialization.blockHeight })
  }
  const scope = JSON.stringify({ format: 'frozen-receipts-v1', chainId: config.chainId ?? null,
    schema: config.eventSchemaVersion ?? '1', contracts: config.contracts.map(c => [c.key, c.contractId, c.driverHash ?? null]).sort() })
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
      for (const entry of parsed.entries) {
        assert.equal(entry.event?.type, 'frozen_receipt', 'Legacy journal: start fresh frozen paths')
        if (entry.event.initialization) { noteInitialization(entry.event.initialization); continue }
        const receipt = decodeStoredReceipt(entry.event.receipt)
        for (const a of policyAdmissions(receipt, contracts, directoryId)) admit(a, entry.meta?.blockHeight, entry.meta?.blockHash)
        followAdmissions(receipt, contracts, directoryId)
      }
    } else {
      assert.equal(size, 0, 'Unbound/legacy journal: use NEW journal/cursor/SQLite paths for archive replay')
      cursor = { ...summarizeEventLogText(''), version: 2, source: archiveSource, scope,
        fromBlock: config.fromBlock, scannedBlockHeight: config.fromBlock - 1, scannedBlockHash: null,
        eventLogBytes: 0, startedAt: new Date().toISOString() }
    }
    const anchor = (await query(`{block(height:${cursor.scannedBlockHeight}){header{height hash timestamp}}}`)).block?.header
    assert(anchor && anchor.height === cursor.scannedBlockHeight, 'Committed cursor block is unavailable')
    hexHash(anchor.hash)
    assert(!cursor.scannedBlockHash || cursor.scannedBlockHash === anchor.hash, 'Committed block hash changed; refusing to mix chains')
    cursor.scannedBlockHash = anchor.hash
    // The last committed block: an initialization journaled outside a new block uses it.
    let committedHeader = anchor
    // A crash can leave appended bytes without a committed cursor. Roll back only that suffix, then refetch it.
    await journal.truncate(cursor.eventLogBytes)
    await journal.sync()
    await syncDirectory(dirname(config.eventLog))
    const replayedEventCount = cursor.eventCount
    const archiveApi = await detectArchiveApi(query)
    await persist({ ...cursor, archiveApi, replayedEventCount, status: 'catching-up', reason: null,
      policyInitializations: Object.fromEntries(policies.status) })
    // The deployment block's events read like any scanned block: same ordinals and receipt ID.
    const blockEvents = async block => {
      const [events] = archiveApi === 'event-batch' ? await eventBatches(query, [block]) : await finalizedBlockEvents(query, [block])
      assert(events, `Archive events unavailable at ${block.header.height}`)
      return events
    }
    // `batch` holds the headers this poll verified; with the committed block and the admitting
    // block they are the collected chain a deployment's block must link to.
    const journalInitialization = async (policy, header, entries, batch = []) => {
      const { admission, block } = policies.admitted.get(policy)
      const verified = new Map([...linked, [committedHeader.height, committedHeader.hash], ...batch.map(b => [b.header.height, b.header.hash])])
      if (block) verified.set(block.height, block.hash)
      let result
      try {
        result = await fetchPolicyInitialization({ query, blockEvents, policy, admission, admittedAt: admission.admitted_at,
          canonicalHash: async height => {
            const hash = await linkedHash(query, height, verified)
            linked.set(height, hash)
            return hash
          },
          driver: [...contracts.values()].find(c => c.key === 'policy').driver, directoryId, vaultId })
      } catch (error) {
        // Only this policy waits; collection and every other projection go on.
        if (signal?.aborted) throw error
        result = { rejected: { code: 'lookup_failed', message: error.message } }
      }
      if (result.rejected) {
        // Fail closed: the API serves no configuration for this policy meanwhile. An archive that lacks
        // the deployment yet, answers for another block or fails is asked again at 5 s, then four
        // times as long each time, up to an hour.
        const previous = policies.status.get(policy), attempts = (previous?.status === 'rejected' ? previous.attempts : 0) + 1
        const retryAt = unavailableInitialization.has(result.rejected.code)
          ? new Date(now() + Math.min(5_000 * 4 ** (attempts - 1), 3_600_000)).toISOString() : undefined
        policies.status.set(policy, { status: 'rejected', ...result.rejected, attempts, ...(retryAt ? { retryAt } : {}) })
        console.error(`Policy ${policy} initialization not authenticated: ${result.rejected.message}${retryAt ? `; retrying at ${retryAt}` : ''}`)
        return
      }
      entries.push(initializationRow(result, header, { source: archiveSource, chainId: config.chainId, directoryId, projectionOptions }))
      noteInitialization(result.initialization)
    }
    while (!signal?.aborted) {
      const committedContracts = new Map(contracts)
      const committedPolicies = clonePolicies(policies)
      const committedEventCount = cursor.eventCount
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
        // Admitted before this collector version or before a restart: journal at the committed block.
        for (const policy of pendingPolicies()) await journalInitialization(policy, committedHeader, entries)
        let scannedBlockHeight = cursor.scannedBlockHeight
        let scannedBlockHash = cursor.scannedBlockHash
        let lastHeader = null
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
            const receipts = new Map()
            for (const [ordinal, raw] of events.entries()) {
              hexHash(raw.source)
              hexHash(raw.origin)
              if (!receipts.has(raw.origin)) receipts.set(raw.origin, [])
              receipts.get(raw.origin).push({ raw, ordinal })
            }
            for (const [txId, rawEvents] of receipts) {
              const receipt = decodeReceipt(rawEvents, header, contracts, directoryId)
              if (!receipt.events.length) continue
              entries.push(jsonSafe({ event: { type: 'frozen_receipt', receipt: encodeReceipt(receipt), projectionOptions },
                meta: { source: archiveSource, timeSource: 'block', chainId: config.chainId ?? null,
                  observedAt: new Date(header.timestamp * 1000).toISOString(), blockHeight: header.height,
                  blockHash: header.hash, txId, eventIndex: rawEvents[0].ordinal, eventId: receipt.id,
                  contractKey: 'frozen', contractId: directoryId } }))
              // A re-admission retries a rejected initialization against its new admission.
              for (const a of policyAdmissions(receipt, contracts, directoryId)) {
                admit(a, header.height, header.hash)
                if (policies.status.get(a.id)?.status === 'rejected') policies.status.delete(a.id)
              }
              // The policy initialized before its admission: journal that directly after the admission.
              for (const policy of pendingPolicies()) await journalInitialization(policy, header, entries, blocks)
            }
          }
          if (batches.length) {
            lastHeader = blocks[batches.length - 1].header
            ;({ height: scannedBlockHeight, hash: scannedBlockHash } = lastHeader)
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
        await persist({ ...cursor, currentBlockHeight, scannedBlockHeight, scannedBlockHash,
          eventCount: cursor.eventCount + entries.length, eventLogBytes: cursor.eventLogBytes + Buffer.byteLength(text),
          ...(last ? { lastEventAt: last.meta.observedAt, lastContract: last.meta.contractKey,
            lastEventName: last.event.type, lastTxId: last.meta.txId, lastBlockHeight: last.meta.blockHeight } : {}),
          status: scannedBlockHeight === finalizedHeight ? 'running' : 'catching-up',
          reason: scannedBlockHeight < to ? `Archive has not finalized block ${scannedBlockHeight + 1} yet` : null,
          policyInitializations: Object.fromEntries(policies.status) })
        if (lastHeader) committedHeader = lastHeader
        if (scannedBlockHeight < finalizedHeight && scannedBlockHeight === to) continue
      } catch (error) {
        if (cursor.eventCount === committedEventCount) {
          contracts.clear()
          for (const [id, contract] of committedContracts) contracts.set(id, contract)
          policies = committedPolicies
        }
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

/**
 * The collected chain's block hash at `height`. `verified` maps heights to hashes this collector
 * verified (scanned and linked, or committed); one of them must lie at or above `height`. Below the
 * nearest one, the archive's headers must link to it by prevBlockHash, exactly as the scan links
 * each batch, so a block the chain did not keep can't stand in. Throws when they don't.
 */
export async function linkedHash(query, height, verified) {
  integer(height)
  let anchor = null
  for (const known of verified.keys()) if (known >= height && (anchor === null || known < anchor)) anchor = known
  assert(anchor !== null, `No collected block at or above ${height}`)
  if (anchor === height) return verified.get(height)
  let previous = null, found = null
  for (let from = height; from <= anchor; from += batchSize) {
    const to = Math.min(from + batchSize - 1, anchor)
    const blocks = (await query(`{blocks(range:[${from},${to}]){header{height hash prevBlockHash}}}`)).blocks
    assert(Array.isArray(blocks) && blocks.length === to - from + 1, 'Incomplete block range')
    for (const [i, block] of blocks.entries()) {
      assert.equal(block.header?.height, from + i, 'Out-of-order block range')
      hexHash(block.header.hash)
      if (previous !== null) assert.equal(block.header.prevBlockHash, previous, `Block ${from + i} does not link to block ${from + i - 1}`)
      previous = block.header.hash
      if (from + i === height) found = previous
    }
  }
  assert.equal(previous, verified.get(anchor), `Block ${height} does not link to the collected block at ${anchor}`)
  return found
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
