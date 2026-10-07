import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { createReloadingLocalIndexerStore } from './stores.mjs'
import { createLocalIndexerHandler } from './routes.mjs'
import { healthResponseForStore } from './health.mjs'
import { createEventLog, envelope, receipt, recordEffects, rootNode, childNode } from '../../scripts/test-fixtures/frozen-events.mjs'
import { cursorMutations, cursorRelations, finalizationFaults } from '../../scripts/test-fixtures/publication-faults.mjs'
import { malformedRows } from '../../scripts/test-fixtures/malformed-rows.mjs'

const lines = entries => entries.map(e => JSON.stringify(e) + '\n').join('')
const base = createEventLog()
const random = seed => () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32 }
const steps = Number(process.env.PUBLICATION_STEPS ?? 96)
const seed = 0x53c091e7
const cursorFaults = [...cursorMutations, ...cursorRelations]
const allActions = ['append', 'append', 'commit', 'crash-tail', 'truncate', 'bad-json', 'repair',
  'unreadable', 'regress', 'restart', 'reset', 'refresh', 'wrong-count', 'wrong-hash', 'past-end',
  'rejected-then-lowered', ...malformedRows.map(({ label }) => `malformed:${label}`),
  ...cursorFaults.map(({ label }) => `cursor:${label}`), ...finalizationFaults.map(({ label }) => `finalize:${label}`)]
// Baseline probes run the same generated actions independently, exposing both findings.
const scenario = process.env.PUBLICATION_SCENARIO
const actions = scenario === 'cursor-height' ? ['cursor:scannedBlockHeight:missing', 'cursor:scannedBlockHeight:null']
  : scenario ? allActions.filter(a => a.startsWith(scenario + ':')) : allActions
assert(actions.length > 0 && Number.isSafeInteger(steps) && steps >= actions.length, `PUBLICATION_STEPS must be an integer >= ${actions.length}`)
const response = (store, url) => new Promise(resolve => {
  let status, headers
  createLocalIndexerHandler(store, { logger: { warn() {}, error() {} } })(
    { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    { writeHead(s, h) { status = s; headers = h }, end(body) { resolve({ status, headers, body }) } })
})

// Independent disk/commit oracle: no production replay/clock/validation helpers.
// Shuffle a full action deck per round so even the bounded CI run covers every
// fault class. Multi-step actions keep important rejected-candidate transitions
// adjacent, checking the publication after EACH transition (including restarts).
it.each(['event-log', 'incremental', 'sqlite'])(`preserves the publication invariant over ${steps} seeded interleavings: %s`, async mode => {
  const started = performance.now(), rng = random(seed)
  const dir = await mkdtemp(join(tmpdir(), 'publication-interleaving-'))
  const eventLogFile = join(dir, 'events.jsonl'), cursorFile = join(dir, 'cursor.json')
  const source = { mode, eventLogFile, cursorFile, file: mode === 'event-log' ? eventLogFile : join(dir, 'events.sqlite') }
  let provider, committed, disk = lines(base), readable = true, retained = null, serial = 0
  let clock = 998, trace = [], deck = [], checks = 0
  const counts = {}, coverage = new Set()
  // Only the generator can create accepted receipts; malformed shapes never enter
  // this registry. This lets repairs/oracle distinguish them without SDK replay.
  const validRows = new Set(base.map(e => JSON.stringify(e)))
  const parseRows = text => text.split('\n').filter(Boolean).map(JSON.parse)
  const replace = async text => { await writeFile(eventLogFile + '.tmp', text); await rename(eventLogFile + '.tmp', eventLogFile); disk = text }
  const append = async text => { disk += text; await appendFile(eventLogFile, text) }
  const commit = async (height = clock, overrides = {}) => {
    committed = { version: 2, source: 'rusk-finalized-archive', status: 'running', fromBlock: 1,
      scannedBlockHash: 'ab'.repeat(32), scannedBlockHeight: height, currentBlockHeight: height + 2,
      eventLogBytes: Buffer.byteLength(disk), eventCount: disk.split('\n').filter(Boolean).length,
      updatedAt: new Date().toISOString(), ...overrides }
    await writeFile(cursorFile + '.tmp', JSON.stringify(committed)); await rename(cursorFile + '.tmp', cursorFile)
    readable = true
  }
  const open = async () => mode === 'incremental' ? createIncrementalSqliteStore(source) : createReloadingLocalIndexerStore(source)
  const restart = async () => { provider.indexer?.close(); retained = null; provider = await open() }
  const edit = height => {
    const entry = envelope(receipt(height, recordEffects(`https://edit-${++serial}.example`), `edit-${serial}`))
    validRows.add(JSON.stringify(entry))
    return lines([entry])
  }
  const cursorValid = () => {
    const c = committed, uint = v => Number.isSafeInteger(v) && v >= 0
    return c.version === 2 && c.source === 'rusk-finalized-archive'
      && ['running', 'catching-up', 'blocked', 'stopped'].includes(c.status)
      && uint(c.eventCount) && uint(c.eventLogBytes) && uint(c.scannedBlockHeight)
      && uint(c.fromBlock) && c.fromBlock > 0 && c.scannedBlockHeight >= c.fromBlock - 1
      && uint(c.currentBlockHeight) && c.currentBlockHeight >= c.scannedBlockHeight
      && typeof c.scannedBlockHash === 'string' && /^[0-9a-f]{64}$/.test(c.scannedBlockHash)
      && typeof c.updatedAt === 'string' && Number.isFinite(Date.parse(c.updatedAt)) && new Date(c.updatedAt).toISOString() === c.updatedAt
  }
  const check = async phase => {
    trace.push(phase); trace = trace.slice(-32); checks++
    let candidate = null
    if (readable && cursorValid() && Buffer.byteLength(disk) >= committed.eventLogBytes) {
      const prefix = Buffer.from(disk).subarray(0, committed.eventLogBytes).toString()
      try {
        assert(prefix === '' || prefix.endsWith('\n'))
        const entries = parseRows(prefix)
        assert.equal(entries.length, committed.eventCount)
        assert(entries.every(e => validRows.has(JSON.stringify(e)) && e.meta.blockHeight <= committed.scannedBlockHeight))
        candidate = { entries, height: committed.scannedBlockHeight }
      } catch { /* Incomplete committed prefix: retain, or 503 after restart. */ }
    }
    if (candidate && (!retained || candidate.height >= retained.height)) retained = candidate
    const stores = await Promise.all([provider(), provider(), provider()])
    assert.equal(new Set(stores).size, 1, 'one refresh/publication per concurrent burst')
    const store = stores[0]
    assert.equal(Boolean(store.unavailable), !retained, 'availability matches existence of a complete publication')
    if (retained) {
      assert.equal(store.projectionBlockHeight, retained.height, 'clock never regresses during a provider lifetime')
      const edits = retained.entries.filter(e => e.meta.eventId.startsWith('edit-'))
      const history = store.recordHistoryByNodeKey.get(`${rootNode}:website`) ?? []
      assert.deepEqual(history.map(e => e.id.split(':')[0]), edits.map(e => e.meta.eventId).reverse(), 'every committed receipt, no uncommitted receipt')
      for (const rows of store.activityByNode.values()) for (const row of rows) assert(row.blockHeight <= store.projectionBlockHeight, 'receipt above clock')
      assert.equal(store.namesByNode.get(rootNode).status, retained.height < 1000 ? 'active' : retained.height < 2000 ? 'grace' : 'released')
      assert.equal(store.subnamesByNode.get(childNode).status, retained.height < 1000 ? 'active' : 'expired')
      assert.equal(store.reverseByEndpoint.size, retained.height < 1000 ? 1 : 0)
      if (candidate && candidate.height >= retained.height) assert.equal(store.checkpoint.eventCount, candidate.entries.length)
      if (!candidate || candidate.height < retained.height) {
        assert(store.warnings.length > 0, 'rejected candidates remain diagnosed')
        assert.equal(healthResponseForStore(store).ok, false)
      }
    } else assert.equal(store.projectionBlockHeight, null)
    const health = await response(store, '/health')
    assert.equal(health.status, 200, 'health remains reachable')
    assert.equal(JSON.parse(health.body).ok, Boolean(candidate && candidate.height >= retained?.height), 'health matches candidate acceptance')
    for (const path of ['/names', '/resolve?name=aurora', '/page/name/aurora.dusk', '/sitemap/names.xml']) {
      const result = await response(store, path)
      assert.equal(result.status, retained ? 200 : 503, path)
      if (retained && path.startsWith('/resolve')) assert.equal(JSON.parse(result.body).verificationStatus, retained.height < 1000 ? 'forward_resolved' : 'unverified')
      if (!retained) assert.equal(result.headers['cache-control'], 'no-store')
    }
    return store
  }
  const reset = async () => { await replace(lines(base)); await commit(); await check('complete-base') }
  try {
    await replace(disk); await commit(); provider = await open(); await check('initial')
    for (let step = 0; step < steps; step++) {
      if (!deck.length) {
        deck = [...actions]
        for (let i = deck.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]
        }
      }
      const action = deck.pop()
      counts[action] = (counts[action] ?? 0) + 1
      trace.push(action)
      try {
        if (action === 'append') await append(edit(++clock))
        else if (action === 'commit') { clock += 1 + Math.floor(rng() * 400); await commit() }
        else if (action === 'crash-tail') await append('{crash-tail')
        else if (action === 'truncate') {
          const size = Math.min(committed.eventLogBytes, Buffer.byteLength(disk))
          await truncate(eventLogFile, size); disk = Buffer.from(disk).subarray(0, size).toString()
        } else if (action === 'bad-json') { await append('{malformed}\n'); await commit() }
        else if (action === 'repair') {
          const valid = disk.split('\n').filter(line => validRows.has(line)).map(JSON.parse)
          await replace(lines(valid.length > 40 ? base : valid))
          if (rng() < 0.5) await commit()
        } else if (action === 'unreadable') { readable = false; await writeFile(cursorFile, '{unreadable') }
        else if (action === 'regress') await commit(Math.max(14, committed.scannedBlockHeight - 500))
        else if (action === 'restart') await restart()
        else if (action === 'reset') await reset()
        else if (action === 'wrong-count') await commit(clock, { eventCount: committed.eventCount + 1 + Math.floor(rng() * 10) })
        else if (action === 'wrong-hash') {
          await reset()
          // The collector verifies chain hashes against the archive. Local readers
          // must preserve the prefix/height invariant even if this diagnostic field
          // changes, including a well-formed but wrong hash and a malformed one.
          for (const scannedBlockHash of ['cd'.repeat(32), 'wrong-hash']) {
            await commit(clock, { scannedBlockHash }); const store = await check(`hash:${scannedBlockHash}`)
            assert.equal(store.cursor.scannedBlockHash, scannedBlockHash)
            if (scannedBlockHash === 'wrong-hash') assert.equal(healthResponseForStore(store).ok, false)
          }
        } else if (action === 'past-end') {
          await commit(clock, { eventLogBytes: Buffer.byteLength(disk) + 1 + Math.floor(rng() * 4096) })
        } else if (action === 'rejected-then-lowered') {
          await reset()
          const published = retained.height, high = clock + 1002 + Math.floor(rng() * 200)
          await append(edit(high))
          await commit(high, { eventCount: base.length + 2 }); await check('high-receipt-wrong-count')
          assert.equal(retained.height, published)
          await commit(published + Math.floor((high - published) / 2)); await check('count-corrected-height-lowered')
          coverage.add('unpublished-height')
          clock = high
          await commit(); await check('high-receipt-recovered')
        } else if (action.startsWith('cursor:') || action.startsWith('finalize:')) {
          // Keep the primary active: expiry would hide resolver finalization errors.
          clock = 998; await replace(lines(base)); await commit(); await restart(); await check('fault-base')
          const before = await response(await provider(), '/names')
          if (action.startsWith('cursor:')) {
            await commit(999, { currentBlockHeight: 1002 })
            const fault = cursorFaults.find(f => action === `cursor:${f.label}`)
            fault.mutate(committed)
            await writeFile(cursorFile, JSON.stringify(committed))
          } else {
            const fault = finalizationFaults.find(f => action === `finalize:${f.label}`)
            await append(lines([fault.row()])); await commit(999)
          }
          for (let repeat = 0; repeat < 2; repeat++) {
            const rejected = await check(`live:${action}`)
            assert.equal((await response(rejected, '/names')).body, before.body, 'retained response is unchanged')
            const failure = healthResponseForStore(rejected).degradedReason
            assert.equal(failure.step, action.startsWith('cursor:') ? 'validate-cursor' : 'finalize')
            assert(failure.message.length > 0, 'failure retains its error')
          }
          coverage.add(`live:${action}`)
          await restart(); await check(`cold:${action}`); coverage.add(`cold:${action}`)
          clock = 999; await reset(); await check(`repaired:${action}`)
        } else if (action.startsWith('malformed:')) {
          const { row, label } = malformedRows.find(({ label }) => action === `malformed:${label}`)
          await reset()
          await append(lines([row])); await commit(++clock); await check(`live-malformed:${label}`)
          coverage.add(`live:${label}`)
          await restart(); await check(`cold-malformed:${label}`)
          coverage.add(`cold:${label}`)
          await reset()
        }
        await check('refresh')
      } catch (error) { error.message = `seed=${seed} mode=${mode} step=${step} actions=${trace.join(',')}: ${error.message}`; throw error }
    }
    assert.equal(Object.keys(counts).length, new Set(actions).size)
    if (!scenario) assert(coverage.has('unpublished-height'))
    if (!scenario) for (const { label } of malformedRows) for (const kind of ['live', 'cold']) assert(coverage.has(`${kind}:${label}`))
    for (const action of actions.filter(a => /^(cursor|finalize):/.test(a))) for (const kind of ['live', 'cold']) assert(coverage.has(`${kind}:${action}`))
    console.info(`seed=${seed} mode=${mode} steps=${steps} checks=${checks} coverage=${coverage.size} duration=${((performance.now() - started) / 1000).toFixed(2)}s`)
  } finally { provider?.indexer?.close(); await rm(dir, { recursive: true, force: true }) }
}, Math.max(60000, steps * 250))
