import assert from 'node:assert/strict'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { encodeReceipt, decodeReceipt as decodeStoredReceipt } from '../../server/local-indexer/receipt-codec.mjs'
import { loadDataDriver } from '@duskdomains/sdk'
import { CollectorEventError, beginReceipt, followAdmissions, jsonSafe, marketAdmissions, policyAdmissions } from './frozen.mjs'
import { fetchMarketInitialization, fetchPolicyInitialization, initializationRow, unavailableInitialization } from './deployment.mjs'
import { parseEventLog } from '../../server/local-indexer/event-log.mjs'
import { summarizeEventLogText } from './cursor-summary.mjs'
import { marketCandidatesFile } from './candidates-file.mjs'

export const archiveSource = 'rusk-finalized-archive'
const pollMs = 5_000
// Blocks per archive read while catching up, and the pause between those reads. Rusk 1.7.1 serves
// at most 200 blocks per `blocks(range:)`. A pause no longer than the poll interval keeps catch-up at
// least as fast as polling at the head, which outpaces the chain even at one block per poll.
export const defaultBatchSize = 100
export const maxBatchSize = 200
export const defaultCatchUpPauseMs = 1_000
export const maxCatchUpPauseMs = pollMs
const frameTopics = new Set(['operation_begin', 'operation_end'])

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
  const { batchSize = defaultBatchSize, catchUpPauseMs = defaultCatchUpPauseMs } = config
  assert(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= maxBatchSize, `Collector batch size must be 1-${maxBatchSize} blocks`)
  assert(Number.isSafeInteger(catchUpPauseMs) && catchUpPauseMs >= 0 && catchUpPauseMs <= maxCatchUpPauseMs,
    `Collector catch-up pause must be 0-${maxCatchUpPauseMs} ms`)
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
  // Likewise a marketplace admitted after launch, configured before its admission outside the
  // scope: its configuration then is journaled after the admitting receipt. `candidates` maps
  // each contract outside the scope that committed a `market_configured` to the first and last
  // scanned transactions that did, and whether it emitted anything else. `admitted` maps each
  // market to its record and the event that admitted it.
  let markets = { admitted: new Map(), initialized: new Set(config.contracts.filter(c => c.key === 'marketplace').map(c => c.contractId)), status: new Map() }
  // Every candidate, however many contracts configure themselves: each costs its own gas, and
  // only its first and last configuration are kept. Changes are appended to their own journal
  // (`candidatesFile`), which the cursor counts like the event log, and undone in memory when a
  // block or poll fails before the cursor is published.
  const candidates = new Map()
  let candidateUndo = [], candidateLines = []
  const setCandidate = (source, value) => {
    candidateUndo.push([source, candidates.get(source)])
    if (value === undefined) candidates.delete(source)
    else candidates.set(source, value)
  }
  const undoCandidates = (undo = 0, lines = 0) => {
    while (candidateUndo.length > undo) {
      const [source, value] = candidateUndo.pop()
      if (value === undefined) candidates.delete(source)
      else candidates.set(source, value)
    }
    candidateLines.length = lines
  }
  const mergeCandidate = ({ source, at, configures, other }) => {
    const prior = candidates.get(source)
    if (prior) setCandidate(source, { first: prior.first, last: configures ? at : prior.last, other: prior.other || other })
    else if (configures) setCandidate(source, { first: at, last: at, other })
  }
  // Events of markets whose deployment has not authenticated, set aside instead of collected.
  let quarantine = new Map()
  // A marketplace is trusted once authenticated, doomed once its authentication failed for good,
  // and pending meanwhile, including while a failed lookup waits to be asked again.
  const trustOf = id => {
    if (contracts.get(id)?.key !== 'marketplace' || markets.initialized.has(id)) return 'trusted'
    const status = markets.status.get(id)
    return status?.status === 'rejected' && !status.retryAt ? 'doomed' : 'pending'
  }
  const quarantined = header => ({ emitter, code, topic, ordinals }) => {
    const previous = quarantine.get(emitter)
    quarantine.set(emitter, { events: (previous?.events ?? 0) + ordinals.length, code, topic,
      firstBlockHeight: previous?.firstBlockHeight ?? header.height, lastBlockHeight: header.height, lastTxId: header.txId })
    console.error(`Quarantined ${ordinals.length} events of unauthenticated marketplace ${emitter} at block ${header.height} (${code})`)
  }
  const admitMarket = (a, receipt) => {
    if (!markets.admitted.has(a.id)) markets.admitted.set(a.id, { record: a.admission, txId: receipt.id.split(':')[1], ordinal: a.ordinal })
  }
  const pendingMarkets = () => [...markets.admitted.keys()].filter(id => {
    const status = markets.status.get(id)
    return !markets.initialized.has(id) && (status?.status !== 'rejected' || (status.retryAt && now() >= Date.parse(status.retryAt)))
  })
  const noteMarketInitialization = initialization => {
    markets.initialized.add(initialization.contractId)
    if (candidates.has(initialization.contractId)) setCandidate(initialization.contractId, undefined)
    markets.status.set(initialization.contractId, { status: 'authenticated', transaction: initialization.transaction, blockHeight: initialization.blockHeight,
      configTransaction: initialization.configTransaction, configBlockHeight: initialization.configBlockHeight })
  }
  // Retain, before decoding admits anything, the market configurations of contracts outside the
  // scope. `collected` holds the ordinals the receipt took in, or set aside after an admission.
  const retain = (rawEvents, header, known, collected) => {
    const bySource = new Map()
    for (const { raw, ordinal } of rawEvents) {
      if (known.has(raw.source) || collected.has(ordinal) || raw.reverted === true) continue
      if (!bySource.has(raw.source)) bySource.set(raw.source, [])
      bySource.get(raw.source).push(raw.topic)
    }
    for (const [source, topics] of bySource) {
      const change = { source, at: { height: header.height, hash: header.hash, txId: rawEvents[0].raw.origin },
        configures: topics.includes('market_configured'), other: topics.some(t => t !== 'market_configured' && !frameTopics.has(t)) }
      if (!candidates.has(source) && !change.configures) continue
      mergeCandidate(change)
      candidateLines.push(JSON.stringify(change) + '\n')
    }
  }
  const rejectInitialization = (state, id, rejected, kind) => {
    // Fail closed: the API serves no configuration for it meanwhile. An archive that lacks the
    // deployment yet, answers for another block or fails is asked again at 5 s, then four times
    // as long each time, up to an hour.
    const previous = state.status.get(id), attempts = (previous?.status === 'rejected' ? previous.attempts : 0) + 1
    const retryAt = unavailableInitialization.has(rejected.code)
      ? new Date(now() + Math.min(5_000 * 4 ** (attempts - 1), 3_600_000)).toISOString() : undefined
    state.status.set(id, { status: 'rejected', ...rejected, attempts, ...(retryAt ? { retryAt } : {}) })
    console.error(`${kind} ${id} initialization not authenticated: ${rejected.message}${retryAt ? `; retrying at ${retryAt}` : ''}`)
  }
  const scope = JSON.stringify({ format: 'frozen-receipts-v1', chainId: config.chainId ?? null,
    schema: config.eventSchemaVersion ?? '1', contracts: config.contracts.map(c => [c.key, c.contractId, c.driverHash ?? null]).sort() })
  await mkdir(dirname(config.eventLog), { recursive: true })
  await mkdir(dirname(config.cursorFile), { recursive: true })
  let cursor = config.truncate ? null : await readOptionalJson(config.cursorFile)
  const journal = await open(config.eventLog, 'a+')
  const candidatesFile = config.candidatesFile ?? marketCandidatesFile(config.cursorFile)
  const candidateJournal = await open(candidatesFile, 'a+')
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
      // Retained configurations hold for the scan that wrote them. A cursor that scanned on
      // without them, such as an older collector's, keeps a stale count: start over. A market
      // whose deployment the scan then no longer covers fails closed (`initialization_not_collected`).
      const retained = cursor.marketCandidatesAt, bytes = cursor.marketCandidatesBytes
      const kept = Number.isSafeInteger(bytes) && bytes >= 0 && retained?.height === cursor.scannedBlockHeight && retained.hash === cursor.scannedBlockHash
      // The cursor vouches for those bytes: without them, markets deployed before and listed later
      // would be lost. Never start over silently, as after restoring a cursor without its journal.
      const held = (await candidateJournal.stat()).size
      assert(!kept || held >= bytes, `Market candidate journal ${candidatesFile} holds ${held} of the ${bytes} bytes its cursor committed: `
        + `restore it from the backup the cursor came from (it belongs beside the cursor as ${basename(candidatesFile)}), `
        + 'or replay into new journal, cursor and SQLite paths (docs/archive-migration.md)')
      if (kept) {
        const text = (await readFile(candidatesFile)).subarray(0, bytes).toString('utf8')
        assert(!text || text.endsWith('\n'), 'Cursor splits a market candidate row')
        for (const line of text.split('\n').filter(Boolean)) mergeCandidate(JSON.parse(line))
      } else if (cursor.marketCandidates || cursor.marketCandidatesBytes !== undefined)
        console.error(`Collector cursor's market configurations are not from block ${cursor.scannedBlockHeight}; retaining anew`)
      cursor = { ...cursor, marketCandidates: undefined, marketCandidatesBytes: kept ? bytes : 0 }
      if (cursor.quarantine && typeof cursor.quarantine === 'object') quarantine = new Map(Object.entries(cursor.quarantine))
      for (const entry of parsed.entries) {
        assert.equal(entry.event?.type, 'frozen_receipt', 'Legacy journal: start fresh frozen paths')
        if (entry.event.initialization) {
          if (entry.event.initialization.role === 'marketplace') noteMarketInitialization(entry.event.initialization)
          else noteInitialization(entry.event.initialization)
          continue
        }
        const receipt = decodeStoredReceipt(entry.event.receipt)
        for (const a of policyAdmissions(receipt, contracts, directoryId)) admit(a, entry.meta?.blockHeight, entry.meta?.blockHash)
        for (const a of marketAdmissions(receipt, contracts, directoryId)) admitMarket(a, receipt)
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
    cursor.marketCandidatesBytes ??= 0
    await candidateJournal.truncate(cursor.marketCandidatesBytes)
    await candidateJournal.sync()
    candidateUndo = []
    await syncDirectory(dirname(config.eventLog))
    await syncDirectory(dirname(candidatesFile))
    const replayedEventCount = cursor.eventCount
    const archiveApi = await detectArchiveApi(query)
    await persist({ ...cursor, archiveApi, replayedEventCount, status: 'catching-up', reason: null,
      policyInitializations: Object.fromEntries(policies.status), marketInitializations: Object.fromEntries(markets.status),
      marketCandidatesAt: { height: cursor.scannedBlockHeight, hash: cursor.scannedBlockHash }, quarantine: Object.fromEntries(quarantine) })
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
      if (result.rejected) return rejectInitialization(policies, policy, result.rejected, 'Policy')
      entries.push(initializationRow(result, header, { source: archiveSource, chainId: config.chainId, directoryId, projectionOptions }))
      noteInitialization(result.initialization)
    }
    // A marketplace's configuration before admission, from the transactions the scan retained: its
    // initialization row once authenticated, or null with the rejection recorded.
    const authenticateMarket = async (market, header) => {
      let result
      try {
        const { record, txId, ordinal } = markets.admitted.get(market)
        result = await fetchMarketInitialization({ query, blockEvents, market, record, candidate: candidates.get(market),
          admission: { txId, ordinal }, driver: [...contracts.values()].find(c => c.key === 'marketplace')?.driver, directoryId, vaultId })
      } catch (error) {
        // Only this market waits; collection and every other projection go on.
        if (signal?.aborted) throw error
        result = { rejected: { code: 'lookup_failed', message: error.message } }
      }
      if (result.rejected) {
        rejectInitialization(markets, market, result.rejected, 'Marketplace')
        return null
      }
      noteMarketInitialization(result.initialization)
      return initializationRow(result, header, { source: archiveSource, chainId: config.chainId, directoryId, projectionOptions })
    }
    const journalMarketInitialization = async (market, header, entries) => {
      const row = await authenticateMarket(market, header)
      if (row) entries.push(row)
    }
    while (!signal?.aborted) {
      // What the published cursor holds. A failure before this poll publishes its own restores it;
      // once it has, even if syncing its directory then fails, its state is the committed one.
      const committedCursor = cursor
      const committedContracts = new Map(contracts)
      const committedPolicies = clonePolicies(policies)
      const committedMarkets = clonePolicies(markets)
      const committedQuarantine = new Map(quarantine)
      candidateUndo = []
      candidateLines = []
      let scannedHeader = null, catchingUp = false
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
        for (const market of pendingMarkets()) await journalMarketInitialization(market, committedHeader, entries)
        let scannedBlockHeight = cursor.scannedBlockHeight
        let scannedBlockHash = cursor.scannedBlockHash
        let lastHeader = null
        let stuck = null
        if (to > scannedBlockHeight) {
          const from = scannedBlockHeight + 1
          // Without contractEventBatch, a block's transactions and transaction root decide whether its events are read.
          const [headerFields, fields] = archiveApi === 'event-batch' ? ['', ''] : [' txRoot', ' transactions{id}']
          const blocks = (await query(`{blocks(range:[${from},${to}]){header{height hash prevBlockHash timestamp${headerFields}}${fields}}}`)).blocks
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
            // A block whose events can't be accepted is never published, nor any block after it.
            // The blocks before it are: projections stop exactly there, fail closed.
            const mark = { entries: entries.length, contracts: new Map(contracts), policies: clonePolicies(policies),
              markets: clonePolicies(markets), candidates: candidateUndo.length, candidateLines: candidateLines.length, quarantine: new Map(quarantine) }
            try {
              const receipts = new Map()
              for (const [ordinal, raw] of events.entries()) {
                hexHash(raw.source)
                hexHash(raw.origin)
                if (!receipts.has(raw.origin)) receipts.set(raw.origin, [])
                receipts.get(raw.origin).push({ raw, ordinal })
              }
              for (const [txId, rawEvents] of receipts) {
                const known = new Set(contracts.keys())
                const decoding = beginReceipt(rawEvents, header, contracts, directoryId, { trust: trustOf })
                retain(rawEvents, header, known, decoding.inScope)
                // A market this transaction lists is authenticated before anything about its events is
                // decided, and its initialization row follows the admitting receipt.
                const listed = []
                for (const a of decoding.admittedMarkets) {
                  admitMarket(a, decoding)
                  const row = await authenticateMarket(a.id, header)
                  if (row) listed.push(row)
                }
                const receipt = decoding.finish({ trust: trustOf, quarantine: quarantined({ ...header, txId }) })
                if (!receipt.events.length) continue
                entries.push(jsonSafe({ event: { type: 'frozen_receipt', receipt: encodeReceipt(receipt), projectionOptions },
                  meta: { source: archiveSource, timeSource: 'block', chainId: config.chainId ?? null,
                    observedAt: new Date(header.timestamp * 1000).toISOString(), blockHeight: header.height,
                    blockHash: header.hash, txId, eventIndex: rawEvents[0].ordinal, eventId: receipt.id,
                    contractKey: 'frozen', contractId: directoryId } }))
                entries.push(...listed)
                // A re-admission retries a rejected initialization against its new admission.
                for (const a of policyAdmissions(receipt, contracts, directoryId)) {
                  admit(a, header.height, header.hash)
                  if (policies.status.get(a.id)?.status === 'rejected') policies.status.delete(a.id)
                }
                for (const a of marketAdmissions(receipt, contracts, directoryId)) admitMarket(a, receipt)
                // The policy initialized before its admission: journal that directly after the admission.
                for (const policy of pendingPolicies()) await journalInitialization(policy, header, entries, blocks)
                // The market's configuration before admission, likewise.
                for (const market of pendingMarkets()) await journalMarketInitialization(market, header, entries)
              }
            } catch (error) {
              if (signal?.aborted) throw error
              entries.length = mark.entries
              contracts.clear()
              for (const [id, contract] of mark.contracts) contracts.set(id, contract)
              policies = mark.policies
              markets = mark.markets
              undoCandidates(mark.candidates, mark.candidateLines)
              quarantine = mark.quarantine
              stuck = blockedAt(error, header)
              break
            }
            lastHeader = header
          }
          if (lastHeader) ({ height: scannedBlockHeight, hash: scannedBlockHash } = lastHeader)
          scannedHeader = lastHeader
        } else {
          assert.equal(scannedBlockHash, finalizedHash, 'Finalized head hash mismatch')
        }
        const text = entries.map(entry => JSON.stringify(entry) + '\n').join('')
        if (text) {
          await journal.writeFile(text)
          await journal.sync()
        }
        const candidateText = candidateLines.join('')
        if (candidateText) {
          await candidateJournal.writeFile(candidateText)
          await candidateJournal.sync()
        }
        const last = entries.at(-1)
        await persist({ ...cursor, currentBlockHeight, scannedBlockHeight, scannedBlockHash,
          eventCount: cursor.eventCount + entries.length, eventLogBytes: cursor.eventLogBytes + Buffer.byteLength(text),
          ...(last ? { lastEventAt: last.meta.observedAt, lastContract: last.meta.contractKey,
            lastEventName: last.event.type, lastTxId: last.meta.txId, lastBlockHeight: last.meta.blockHeight } : {}),
          status: stuck ? 'blocked' : scannedBlockHeight === finalizedHeight ? 'running' : 'catching-up',
          reason: stuck ? stuck.message : scannedBlockHeight < to ? `Archive has not finalized block ${scannedBlockHeight + 1} yet` : null,
          blocked: stuck ? blockedRecord(stuck) : undefined,
          policyInitializations: Object.fromEntries(policies.status), marketInitializations: Object.fromEntries(markets.status),
          marketCandidatesBytes: cursor.marketCandidatesBytes + Buffer.byteLength(candidateText),
          marketCandidatesAt: { height: scannedBlockHeight, hash: scannedBlockHash }, quarantine: Object.fromEntries(quarantine) })
        candidateUndo = []
        candidateLines = []
        if (stuck) console.error(`Collector blocked at block ${stuck.height}: ${stuck.message}`)
        if (lastHeader) committedHeader = lastHeader
        // A whole batch done and the finalized head further on: read the next batch after the pause.
        catchingUp = scannedBlockHeight < finalizedHeight && scannedBlockHeight === to
      } catch (error) {
        if (cursor === committedCursor) {
          contracts.clear()
          for (const [id, contract] of committedContracts) contracts.set(id, contract)
          policies = committedPolicies
          markets = committedMarkets
          quarantine = committedQuarantine
          undoCandidates()
        } else {
          if (scannedHeader) committedHeader = scannedHeader
          candidateUndo = []
          candidateLines = []
        }
        // Never advance past a missing archive, invalid payload, or failed durable write.
        await journal.truncate(cursor.eventLogBytes)
        await journal.sync()
        await candidateJournal.truncate(cursor.marketCandidatesBytes)
        await candidateJournal.sync()
        const failure = blockedAt(error, { height: cursor.scannedBlockHeight + 1, hash: null })
        await persist({ ...cursor, status: 'blocked', reason: error.message, blocked: blockedRecord(failure) })
        console.error(`Collector blocked at block ${failure.height}: ${error.message}`)
      }
      // At the finalized head, after a partial batch or a failure, poll again as before.
      const pause = catchingUp ? catchUpPauseMs : pollMs
      if (pause) try { await wait(pause, undefined, { signal }) } catch (error) { if (!signal?.aborted) throw error }
    }
    await persist({ ...cursor, status: 'stopped' })
  } finally {
    await journal.close()
    await candidateJournal.close()
  }

  // Where and why collection stopped: the first block not published, and since when.
  function blockedRecord(failure) {
    const { message, ...where } = failure, previous = cursor.blocked
    const same = previous?.height === where.height && previous?.code === where.code
    return { ...where, since: same ? previous.since : new Date(now()).toISOString(), attempts: same ? previous.attempts + 1 : 1 }
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
  for (let from = height; from <= anchor; from += defaultBatchSize) {
    const to = Math.min(from + defaultBatchSize - 1, anchor)
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
// for the leading blocks checkBlock confirms, empty blocks included in the check. Finalizing regroups
// events by transaction hash; put them back in the block's transaction order, with block-level events
// (rewards, slashes) last. Slashes run first in Rusk 1.7, so their block's eventIndex values differ
// from contractEventBatch's.
async function finalizedBlockEvents(query, blocks) {
  const aliased = (list, field) => '{' + list.map(({ header }, i) => `b${i}:${field(header)}`).join(' ') + '}'
  const checks = await query(aliased(blocks, ({ height, hash }) => `checkBlock(height:${height},hash:"${hash}",onlyFinalized:true)`))
  const missing = blocks.findIndex((_, i) => checks[`b${i}`] !== true)
  const archived = missing === -1 ? blocks : blocks.slice(0, missing)
  if (!archived.length) return []
  const read = archived.filter(block => !withoutTransactions(block))
  const events = read.length ? await query(aliased(read, ({ hash }) => `contractEvents(hash:"${hash}"){json}`)) : {}
  return archived.map(block => {
    if (withoutTransactions(block)) return []
    const { header, transactions } = block, json = events[`b${read.indexOf(block)}`]?.json
    assert(Array.isArray(json) && Array.isArray(transactions), `Archive events unavailable at ${header.height}`)
    const position = new Map(transactions.map(({ id }, index) => [id, index]))
    for (const { origin } of json) assert(position.has(origin) || origin === header.hash, `Archive event from unknown origin at ${header.height}`)
    return json.toSorted((a, b) => (position.get(a.origin) ?? position.size) - (position.get(b.origin) ?? position.size))
  })
}

// Outside its transactions a Rusk 1.7 block runs only the genesis stake and transfer contracts
// (slashes, rewards, the transfer root update), so a block without transactions holds no event of
// the collected contracts and no market configuration. Its events are skipped only when two sources
// agree it has none: its transaction list (every executed transaction, failed ones included) and its
// header's transaction root (checked by consensus, zero only without transactions). Anything else,
// a missing or malformed field included, is read as before.
const emptyTxRoot = '0'.repeat(64)
function withoutTransactions({ header, transactions }) {
  return Array.isArray(transactions) && transactions.length === 0 && header?.txRoot === emptyTxRoot
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

/**
 * Why collection cannot pass `header`. An event or admission it cannot accept is a decoder
 * problem; everything else is the archive's, the chain link's or the collector's own.
 */
function blockedAt(error, header) {
  const tagged = error instanceof CollectorEventError
  const code = tagged ? error.code
    : /hash chain|hash mismatch|does not link|block hash changed/i.test(error.message) ? 'chain_mismatch'
      : /^(?:Archive |Invalid archive )|block range|unavailable|Finalized head is behind/.test(error.message) ? 'archive_unavailable'
        : 'collector_error'
  return { code, height: header.height, blockHash: header.hash ?? null, txId: tagged ? error.txId : null,
    emitter: tagged ? error.emitter : null, role: tagged ? error.role : null, topic: tagged ? error.topic : null, message: error.message }
}
