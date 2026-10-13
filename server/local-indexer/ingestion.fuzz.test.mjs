import { expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, writeFile, appendFile, rm, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJson, stringifyJson, wireValue, loadDataDriver } from '@duskdomains/sdk'
import { indexerEventCatalog } from '@duskdomains/sdk/event-catalog'
import { createReloadingLocalIndexerStore } from './stores.mjs'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { replayEventLog } from './event-log-store.mjs'
import { createEventLog, envelope, receipt, recordEffects, id, scope } from '../../scripts/test-fixtures/frozen-events.mjs'
import { commitJournal } from '../../scripts/test-fixtures/committed-cursor.mjs'
import { decodeReceipt as archiveReceipt, topicsFor } from '../../scripts/local-event-collector/frozen.mjs'
import { decodeReceipt } from './receipt-codec.mjs'
import { check, count, testTimeout } from '../../scripts/test-fixtures/fuzz-support.mjs'
import { initializationEntry, policyDeployment, setPolicy } from '../../scripts/test-fixtures/policy-replacement.mjs'
import { jsonSafe } from './frozen-view.mjs'

// Every property builds the same committed journal three ways: the event-log
// reload store, the SQLite reload store and the incremental SQLite store used
// by `npm start -- --sqlite ... --event-log ... --watch`. All three must publish
// identical state; a rejected candidate must retain the previous publication.
vi.setConfig({ testTimeout })
const edits = fc.array(fc.integer({ min: 0, max: 1000000 }), { minLength: 1, maxLength: 8 })
const journal = values => [...createEventLog(), ...values.map((value, index) =>
  envelope(receipt(20 + index, recordEffects(`https://record-${value}.example`), `edit-${index}`)))]
const jsonl = rows => rows.map(row => (typeof row === 'string' ? row : JSON.stringify(row)) + '\n').join('')
const viewKeys = Object.keys(replayEventLog(createEventLog(), [], '2026-10-07T12:00:00Z', 100))
const published = store => Object.fromEntries(viewKeys.map(key => [key, store[key]]))
// Documented repair: atomically replace the journal (an in-place rewrite of
// committed bytes is covered by the in-place rewrite regression).
async function replaceJournal(file, contents) {
  await writeFile(`${file}.repair`, contents)
  await rename(`${file}.repair`, file)
}

async function withStores(rows, run) {
  const directory = await mkdtemp(join(tmpdir(), 'indexer-fuzz-'))
  const eventLogFile = join(directory, 'events.jsonl'), cursorFile = join(directory, 'cursor.json')
  const providers = []
  try {
    await writeFile(eventLogFile, jsonl(rows))
    await commitJournal(eventLogFile, { scannedBlockHeight: 100, currentBlockHeight: 100 }, cursorFile)
    const eventLog = await createReloadingLocalIndexerStore({ mode: 'event-log', file: eventLogFile, cursorFile })
    const sqlite = await createReloadingLocalIndexerStore({ mode: 'sqlite', file: join(directory, 'events.sqlite'), eventLogFile, cursorFile })
    const incremental = await createIncrementalSqliteStore({ mode: 'sqlite', file: join(directory, 'incremental.sqlite'), eventLogFile, cursorFile })
    providers.push(incremental)
    const stores = { eventLog, sqlite, incremental }
    const before = await reload(stores)
    for (const view of Object.values(before)) {
      expect(view.warnings).toEqual([])
      expect(published(view)).toEqual(published(before.eventLog))
    }
    const restart = async () => {
      const cold = await createIncrementalSqliteStore({ mode: 'sqlite', file: join(directory, `cold-${providers.length}.sqlite`), eventLogFile, cursorFile })
      providers.push(cold)
      return { cold: await cold(), coldLog: await (await createReloadingLocalIndexerStore({ mode: 'event-log', file: eventLogFile, cursorFile }))() }
    }
    await run({ stores, eventLogFile, cursorFile, before, restart })
  } finally {
    for (const provider of providers) provider.indexer.close()
    await rm(directory, { recursive: true, force: true })
  }
}
async function reload(stores) {
  return Object.fromEntries(await Promise.all(Object.entries(stores).map(async ([mode, provider]) => [mode, await provider()])))
}
/** All modes agree; a rejection keeps the retained publication at its old clock. */
function agree(views, retained, oldHeight) {
  const rejected = Object.values(views).map(v => v.warnings.length > 0)
  expect(new Set(rejected).size, `modes disagree on rejection: ${JSON.stringify(Object.fromEntries(Object.entries(views).map(([m, v]) => [m, v.warnings])))}`).toBe(1)
  for (const view of Object.values(views)) expect(published(view)).toEqual(published(views.eventLog))
  if (rejected[0]) {
    for (const view of Object.values(views)) {
      expect(published(view)).toEqual(retained)
      expect(view.projectionBlockHeight).toBe(oldHeight)
    }
  }
  return rejected[0]
}

it('ingestion: generated valid histories have identical event-log, SQLite and incremental publications', async () => {
  await check('ingestion/valid-storage-equivalence', fc.asyncProperty(edits, fc.boolean(), async (values, append) => {
    const rows = journal(values)
    await withStores(rows.slice(0, 5), async ({ stores, eventLogFile, cursorFile, restart }) => {
      if (append) await appendFile(eventLogFile, jsonl(rows.slice(5)))
      else await writeFile(eventLogFile, jsonl(rows))
      await commitJournal(eventLogFile, { scannedBlockHeight: 101, currentBlockHeight: 101 }, cursorFile)
      const views = await reload(stores)
      for (const view of Object.values(views)) expect(view.warnings).toEqual([])
      expect(agree(views)).toBe(false)
      expect(views.eventLog.projectionBlockHeight).toBe(101)
      // Restart reconstruction, rather than comparing only retained views.
      const { cold, coldLog } = await restart()
      expect(published(cold)).toEqual(published(views.eventLog))
      expect(published(coldLog)).toEqual(published(views.eventLog))
    })
  }), { weight: 0.25 })
})

// Documented rejections: each mutation must block the candidate in every mode,
// retain the previous publication, and recover after an atomic repair.
for (const mutation of ['truncated-json', 'wrong-payload-type', 'reordered-events', 'duplicate-ordinal', 'reordered-receipts']) {
  it(`ingestion ${mutation}: rejected candidates retain the whole published view in all modes`, async () => {
    await check(`ingestion/${mutation}`, fc.asyncProperty(edits, fc.nat(), async (values, cut) => {
      const rows = journal(values)
      await withStores(rows, async ({ stores, eventLogFile, cursorFile, before }) => {
        const bad = envelope(receipt(110, recordEffects('https://unpublished.example'), 'candidate'))
        if (mutation === 'wrong-payload-type') bad.event.receipt.events[1].data = 'null'
        if (mutation === 'reordered-events') bad.event.receipt.events.reverse()
        if (mutation === 'duplicate-ordinal') bad.event.receipt.events[1].ordinal = bad.event.receipt.events[0].ordinal
        let next = [...rows, bad]
        if (mutation === 'reordered-receipts') next = [...rows, bad, envelope(receipt(109, recordEffects('https://older.example'), 'older'))]
        let contents = jsonl(next)
        if (mutation === 'truncated-json') {
          const line = JSON.stringify(bad)
          contents = jsonl(rows) + line.slice(0, 1 + cut % (line.length - 1)) + '\n'
        }
        await writeFile(eventLogFile, contents)
        await commitJournal(eventLogFile, { scannedBlockHeight: 111, currentBlockHeight: 111 }, cursorFile)
        const retained = structuredClone(published(before.eventLog))
        expect(agree(await reload(stores), retained, 100)).toBe(true)
        // Repair must actually rebuild and advance, not permanently serve the old cache.
        await writeFile(eventLogFile, jsonl(rows))
        await commitJournal(eventLogFile, { scannedBlockHeight: 112, currentBlockHeight: 112 }, cursorFile)
        const repaired = await reload(stores)
        expect(agree(repaired)).toBe(false)
        expect(repaired.incremental.projectionBlockHeight).toBe(112)
      })
    }), { weight: 0.25 })
  })
}

for (const mutation of ['duplicate-receipt', 'unfinished-frame', 'uncommitted-tail']) {
  it(`ingestion ${mutation}: no uncommitted effects become public`, async () => {
    await check(`ingestion/${mutation}`, fc.asyncProperty(edits, async values => {
      const rows = journal(values)
      await withStores(rows, async ({ stores, eventLogFile, cursorFile, before }) => {
        let next = [...rows]
        if (mutation === 'duplicate-receipt') next.push(rows.at(-1))
        else {
          const entry = envelope(receipt(110, recordEffects('https://unpublished.example'), 'candidate'))
          // Drop every operation_end: each complete effect remains inside an unfinished frame.
          if (mutation === 'unfinished-frame') entry.event.receipt.events = entry.event.receipt.events.filter(e => e.topic !== 'operation_end')
          next.push(entry)
        }
        const oldCursor = await readFile(cursorFile, 'utf8')
        await writeFile(eventLogFile, jsonl(next))
        if (mutation !== 'uncommitted-tail') await commitJournal(eventLogFile, { scannedBlockHeight: 100, currentBlockHeight: 100 }, cursorFile)
        else expect(await readFile(cursorFile, 'utf8')).toBe(oldCursor)
        const views = await reload(stores)
        agree(views, published(before.eventLog), 100)
        for (const view of Object.values(views)) expect(published(view)).toEqual(published(before.eventLog))
      })
    }), { weight: 0.25 })
  })
}

// Adversarial archive rows: random structural mutations of candidate journal
// rows (truncation, wrong JSON types, deleted fields, reordered or duplicated
// events and receipts, mutated payloads, heights, emitters and topics), written
// by appending or by replacing the journal, committed or not. Whatever the
// outcome, all modes agree, rejection retains the last publication, acceptance
// equals a cold restart, and a repair always recovers.
const step = fc.record({ op: fc.nat(), path: fc.nat(), pick: fc.nat(), json: fc.jsonValue({ maxDepth: 2 }) })
const OPS = ['truncate', 'json-row', 'set', 'set', 'delete', 'swap-events', 'duplicate-event', 'drop-event', 'swap-rows',
  'duplicate-row', 'payload', 'payload', 'height', 'topic', 'emitter', 'flag']
function paths(value, path = [], out = []) {
  out.push(path)
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) paths(v, [...path, Array.isArray(value) ? Number(k) : k], out)
  return out
}
function setAt(value, path, replacement) {
  if (!path.length) return replacement
  const copy = Array.isArray(value) ? [...value] : { ...value }
  copy[path[0]] = setAt(value?.[path[0]], path.slice(1), replacement)
  return copy
}
function deleteAt(value, path) {
  if (path.length === 1) {
    if (Array.isArray(value)) return value.filter((_, i) => i !== path[0])
    const { [path[0]]: _, ...rest } = value
    return rest
  }
  return setAt(value, path.slice(0, 1), deleteAt(value[path[0]], path.slice(1)))
}
const topics = Object.keys(indexerEventCatalog)
function adversarial(rows, candidates, steps) {
  let tail = candidates.map(row => structuredClone(row))
  for (const s of steps) {
    const op = OPS[s.op % OPS.length], i = s.pick % tail.length
    const row = tail[i], events = row?.event?.receipt?.events
    if (op === 'truncate') { const line = JSON.stringify(row); tail[i] = line.slice(0, s.path % line.length) }
    else if (op === 'json-row') tail[i] = JSON.stringify(s.json)
    else if (op === 'set' && typeof row === 'object') { const all = paths(row); tail[i] = setAt(row, all[s.path % all.length], s.json) }
    else if (op === 'delete' && typeof row === 'object') { const all = paths(row).filter(p => p.length); tail[i] = deleteAt(row, all[s.path % all.length]) }
    else if (Array.isArray(events) && events.length && ['swap-events', 'duplicate-event', 'drop-event', 'payload', 'topic', 'emitter', 'flag'].includes(op)) {
      const e = s.path % events.length, other = (s.path >> 3) % events.length
      if (op === 'swap-events') [events[e], events[other]] = [events[other], events[e]]
      if (op === 'duplicate-event') events.splice(e, 0, structuredClone(events[e]))
      if (op === 'drop-event') events.splice(e, 1)
      if (op === 'topic') events[e].topic = s.pick % 5 ? topics[s.pick % topics.length] : String(s.json)
      if (op === 'emitter') events[e].emitter = s.pick % 3 ? Object.keys(scope)[s.pick % 6] : id(s.pick % 256)
      if (op === 'flag') { if (s.pick % 2) events[e].reverted = s.pick % 4 === 1 ? true : s.json; else row.event.receipt.success = s.pick % 4 === 0 ? false : s.json }
      if (op === 'payload' && typeof events[e].data === 'string') {
        try {
          const data = parseJson(events[e].data), all = paths(data), target = all[s.path % all.length]
          const replacement = s.pick % 3 === 0 ? s.json : s.pick % 3 === 1 ? 18446744073709551616n : (s.pick % 2 ? -1 : 2 ** 53)
          events[e].data = (() => { try { return stringifyJson(setAt(data, target, replacement)) } catch { return JSON.stringify(s.json) } })()
        } catch { events[e].data = JSON.stringify(s.json) }
      }
    } else if (op === 'swap-rows' && tail.length > 1) { const j = (i + 1) % tail.length; [tail[i], tail[j]] = [tail[j], tail[i]] }
    else if (op === 'duplicate-row') tail.splice(i, 0, s.pick % 2 ? structuredClone(rows[s.path % rows.length]) : structuredClone(row))
    else if (op === 'height' && typeof row === 'object' && row?.event?.receipt) {
      const height = [0, 99, 100, 109, 111, 2 ** 53, -1][s.path % 7]
      row.event.receipt.height = String(height)
      if (s.pick % 2 && row.meta) row.meta.blockHeight = height
    }
  }
  return tail
}
it('ingestion: adversarial archive rows never corrupt published state in any storage mode', async () => {
  const metrics = {}
  await check('ingestion/adversarial-rows', fc.asyncProperty(edits, fc.array(step, { minLength: 1, maxLength: 4 }), fc.boolean(), fc.boolean(),
    async (values, steps, append, commit) => {
      const rows = journal(values)
      await withStores(rows, async ({ stores, eventLogFile, cursorFile, before, restart }) => {
        const candidates = [envelope(receipt(110, recordEffects('https://candidate.example'), 'candidate-a')),
          envelope(receipt(110, recordEffects('https://candidate-b.example'), 'candidate-b'))]
        const tail = adversarial(rows, candidates, steps)
        if (append) await appendFile(eventLogFile, jsonl(tail))
        else await writeFile(eventLogFile, jsonl([...rows, ...tail]))
        if (commit) await commitJournal(eventLogFile, { scannedBlockHeight: 111, currentBlockHeight: 111 }, cursorFile)
        const retained = structuredClone(published(before.eventLog))
        const views = await reload(stores)
        const rejected = agree(views, retained, 100)
        count(metrics, `${commit ? 'committed' : 'uncommitted'}:${rejected ? 'rejected' : 'accepted'}`)
        if (!commit) for (const view of Object.values(views)) expect(published(view)).toEqual(retained)
        if (!rejected) {
          const { cold, coldLog } = await restart()
          expect(published(cold)).toEqual(published(views.eventLog))
          expect(published(coldLog)).toEqual(published(views.eventLog))
        }
        // Repair: replace the journal with valid rows and a non-regressing cursor.
        await replaceJournal(eventLogFile, jsonl([...rows, ...candidates]))
        await commitJournal(eventLogFile, { scannedBlockHeight: 112, currentBlockHeight: 112 }, cursorFile)
        const repaired = await reload(stores)
        expect(agree(repaired)).toBe(false)
        expect(repaired.eventLog.projectionBlockHeight).toBe(112)
      })
    }), { weight: 0.2, metrics })
})

// A policy replacement journals a SetPolicy row and the policy's deployment initialization
// after it. Mutating, reordering, duplicating or dropping either row keeps every mode in
// agreement; a rejection retains the last publication and an accepted view serves only the
// selected policy's authenticated configuration or none.
it('ingestion: mutated policy replacement rows never corrupt published state in any storage mode', async () => {
  const metrics = {}, replacement = policyDeployment(), authenticated = jsonSafe(replacement.args.config)
  await check('ingestion/policy-replacement-rows', fc.asyncProperty(edits, fc.array(step, { minLength: 1, maxLength: 4 }), fc.boolean(), fc.boolean(),
    async (values, steps, append, commit) => {
      const rows = journal(values)
      await withStores(rows, async ({ stores, eventLogFile, cursorFile, before, restart }) => {
        const candidates = [envelope(receipt(110, [setPolicy(110, replacement)], 'set-policy')),
          initializationEntry(replacement, { deployedAt: 105, journaledAt: 110 })]
        const tail = adversarial(rows, candidates, steps)
        if (append) await appendFile(eventLogFile, jsonl(tail))
        else await writeFile(eventLogFile, jsonl([...rows, ...tail]))
        if (commit) await commitJournal(eventLogFile, { scannedBlockHeight: 111, currentBlockHeight: 111 }, cursorFile)
        const retained = structuredClone(published(before.eventLog))
        const views = await reload(stores)
        const rejected = agree(views, retained, 100)
        count(metrics, `${commit ? 'committed' : 'uncommitted'}:${rejected ? 'rejected' : 'accepted'}`)
        if (!commit) for (const view of Object.values(views)) expect(published(view)).toEqual(retained)
        if (!rejected) {
          const policy = views.eventLog.policy
          if (policy?.contractId === `0x${replacement.policy}` && policy.config) {
            count(metrics, 'served-replacement')
            // The receipt's arguments are collector-decoded, as for every journaled event.
            const served = views.eventLog.feeConfig
            expect(served.policy).toEqual(policy)
            if (stringifyJson(policy.config) !== stringifyJson(authenticated)) count(metrics, 'served-journaled-arguments')
          }
          const { cold, coldLog } = await restart()
          expect(published(cold)).toEqual(published(views.eventLog))
          expect(published(coldLog)).toEqual(published(views.eventLog))
        }
        await replaceJournal(eventLogFile, jsonl([...rows, ...candidates]))
        await commitJournal(eventLogFile, { scannedBlockHeight: 112, currentBlockHeight: 112 }, cursorFile)
        const repaired = await reload(stores)
        expect(agree(repaired)).toBe(false)
        expect(repaired.eventLog.feeConfig.policy).toMatchObject({ contractId: `0x${replacement.policy}`, config: authenticated })
      })
    }), { weight: 0.2, metrics })
})

// Collector: archive rollback metadata, topics, sources and byte encodings are
// validated before a receipt reaches the journal; a decoding failure stops the
// collector (it throws) rather than journaling a partial receipt.
it('collector: rollback metadata and JSON event typing are validated before admission', async () => {
  await check('collector/archive-envelope', fc.property(fc.integer({ min: 1, max: 255 }),
    fc.constantFrom('valid', 'reverted', 'missing-rollback', 'wrong-rollback', 'wrong-data-type', 'odd-hex', 'unknown-topic', 'foreign-role-topic', 'unknown-source'),
    (suffix, mutation) => {
      const decoded = decodeReceipt(envelope(receipt(110, recordEffects(`https://record-${suffix}.example`))).event.receipt)
      const contracts = new Map(Object.entries(scope).map(([contractId, key]) => [contractId, { key, contractId, events: topicsFor(key),
        // Archive envelope properties use a deterministic JSON fixture codec;
        // the real store driver is exercised by the next property.
        driver: { decodeEvent: (_topic, data) => parseJson(data.toString('utf8')) },
      }]))
      const raw = decoded.events.map((event, ordinal) => ({ ordinal, raw: { source: event.emitter, origin: id(200),
        topic: event.topic, reverted: mutation === 'reverted', data: Buffer.from(stringifyJson(event.data)).toString('hex') } }))
      if (mutation === 'missing-rollback') delete raw[0].raw.reverted
      if (mutation === 'wrong-rollback') raw[0].raw.reverted = 1
      if (mutation === 'wrong-data-type') raw[0].raw.data = suffix
      if (mutation === 'odd-hex') raw[1].raw.data += 'f'
      if (mutation === 'unknown-topic') raw[1].raw.topic = `unknown_${suffix}`
      if (mutation === 'foreign-role-topic') raw[1].raw.topic = 'order_changed'
      if (mutation === 'unknown-source') raw.forEach(r => { r.raw.source = id(7 + (suffix % 240)) })
      const operation = () => archiveReceipt(raw, { height: 110, hash: id(201) }, contracts, id(1))
      if (mutation === 'valid' || mutation === 'reverted') expect(operation().events.length).toBe(mutation === 'reverted' ? 0 : decoded.events.length)
      else if (mutation === 'unknown-source') expect(operation().events).toEqual([])
      else expect(operation).toThrow()
      expect([...contracts.keys()]).toEqual(Object.keys(scope))
    }))
})

// Collector with the real (pinned) store data driver: mutated golden event
// bytes either stop the collector or decode to SDK-valid, committed effects.
const golden = parseJson(gunzipSync(readFileSync(new URL('../../scripts/test-fixtures/frozen/frozen-v1.json.gz', import.meta.url))).toString())
const storeDriver = await loadDataDriver(gunzipSync(readFileSync(new URL('../../scripts/test-fixtures/frozen/store.wasm.gz', import.meta.url))))
const storeTopics = Object.entries(indexerEventCatalog).filter(([, spec]) => spec.role === 'store')
it('collector: mutated store event bytes through the real driver stop collection or decode to SDK-valid effects', async () => {
  const metrics = {}
  await check('collector/store-driver-bytes', fc.property(fc.nat(), fc.array(fc.record({ at: fc.nat(), value: fc.integer({ min: 0, max: 255 }) }), { maxLength: 3 }),
    fc.nat(), (pick, flips, cut) => {
      const [topic, spec] = storeTopics[pick % storeTopics.length]
      const row = Object.values(golden).find(r => r.type === spec.type)
      let bytes = Buffer.from(row.rkyv, 'hex')
      for (const f of flips) bytes[f.at % bytes.length] = f.value
      if (cut % 5 === 0) bytes = bytes.subarray(0, cut % bytes.length)
      const store = id(4), height = 110n, call_path = [Array(32).fill(4)]
      const frame = (topic, data) => Buffer.from(stringifyJson(data)).toString('hex')
      const contracts = new Map(Object.entries(scope).map(([contractId, key]) => [contractId, { key, contractId, events: topicsFor(key),
        driver: { decodeEvent: (t, data) => t === 'operation_begin' || t === 'operation_end' ? parseJson(data.toString('utf8')) : storeDriver.decodeEvent(t, data) } }]))
      const raw = [
        { ordinal: 0, raw: { source: store, origin: id(200), topic: 'operation_begin', reverted: false, data: frame('operation_begin', { op_seq: 1n, height, call_path }) } },
        { ordinal: 1, raw: { source: store, origin: id(200), topic, reverted: false, data: bytes.toString('hex') } },
        { ordinal: 2, raw: { source: store, origin: id(200), topic: 'operation_end', reverted: false, data: frame('operation_end', { op_seq: 1n, call_path }) } },
      ]
      let result
      try { result = archiveReceipt(raw, { height: 110, hash: id(201) }, contracts, id(1)) } catch { count(metrics, 'collector-stops'); return }
      count(metrics, 'decoded')
      for (const event of result.events) wireValue(indexerEventCatalog[event.topic].type, event.data)
      expect(result.events.map(e => e.ordinal)).toEqual([...result.events.map(e => e.ordinal)].sort((a, b) => a - b))
    }), { metrics })
})
