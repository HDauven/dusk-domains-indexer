import { afterEach, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { DEFAULT_FEE_CONFIG } from '@duskdomains/sdk/projection'
import { createReplayState, applyReplayEvent, finalizeReplayState } from './event-log-store.mjs'
import { createLocalIndexerHandler } from './routes.mjs'
import { loadSnapshotStore } from './snapshot.mjs'
import { createIncrementalSqliteStore } from './incremental-sqlite-store.mjs'
import { writeSnapshot, writeEventLog, writeCursor } from '../local-indexer-test-helpers.mjs'
import { premiumForName } from './read-models/premium.mjs'

const node = `0x${'01'.repeat(32)}`
const grace = 100_000
const now = '2026-10-03T12:00:00.000Z'
const lifecycle = { node, canonicalName: 'aurora.dusk', owner: node, manager: node, status: 'active',
  expiresAt: '2030-01-01T00:00:00.000Z', graceEndsAt: '2031-01-01T00:00:00.000Z',
  expiresAtBlockHeight: grace - 100, graceEndsAtBlockHeight: grace }
const registration = { event: { ...lifecycle, type: 'name_registered', label: 'aurora', actor: node, feeLux: 110, premiumLux: 100 }, meta: { blockHeight: 1, txId: 'registration' } }
const fees = { event: { type: 'fee_config_updated', config: DEFAULT_FEE_CONFIG }, meta: { blockHeight: 2, txId: 'fees' } }
const premium = day => Number((BigInt(DEFAULT_FEE_CONFIG.premiumStartLux) >> BigInt(day)) - (BigInt(DEFAULT_FEE_CONFIG.premiumStartLux) >> 21n))

afterEach(() => vi.useRealTimers())

function request(store, url) {
  return new Promise(resolve => createLocalIndexerHandler(store)(
    { url, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    { writeHead(status) { expect(status).toBe(200) }, end(body) { resolve(JSON.parse(body)) } },
  ))
}

it.each(['snapshot', 'replay', 'sqlite'])('exposes the current premium in search and name responses from %s', async mode => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  let store
  let provider
  if (mode === 'snapshot') {
    store = await loadSnapshotStore(await writeSnapshot({ names: [{ ...lifecycle, registrationPremiumLux: 42 }], treasury: { premiumReceivedLux: 42 }, feeConfig: DEFAULT_FEE_CONFIG, currentBlockHeight: grace }))
  } else if (mode === 'sqlite') {
    const eventLogFile = await writeEventLog([registration, fees])
    const cursorFile = await writeCursor({ currentBlockHeight: grace, scannedBlockHeight: grace })
    provider = await createIncrementalSqliteStore({ file: join(dirname(eventLogFile), 'index.sqlite'), eventLogFile, cursorFile })
    store = await provider()
  } else {
    const state = createReplayState()
    for (const event of [registration, fees]) applyReplayEvent(state, event, [])
    store = finalizeReplayState(state, now, grace)
  }
  try {
    for (const day of [0, 1, 10, 20, 21]) {
      store = { ...store, cursor: { currentBlockHeight: grace + day * 8_640 } }
      const expected = day < 21 ? premium(day) : 0
      const search = await request(store, '/search?query=aurora')
      const name = await request(store, `/name?node=${node}`)
      expect(search).toMatchObject({ status: 'available', premiumLux: expected, price: 10 + expected / 1e9, graceEndsAtBlockHeight: grace })
      expect(name).toMatchObject({ premiumLux: expected, premiumEndsAtBlockHeight: day < 21 ? grace + 21 * 8_640 : null })
      expect(name.premiumEndsAt).toBe(search.premiumEndsAt)
      if (day < 21) {
        expect(Date.parse(search.premiumEndsAt)).toBe(Date.parse(now) + (21 - day) * 86_400_000)
        expect(Date.parse(search.premiumNextStepAt)).toBe(Date.parse(now) + 86_400_000)
      }
    }
    if (mode === 'snapshot') {
      expect(await request(store, '/treasury')).toMatchObject({ premiumReceivedLux: 42 })
      expect(await request(store, `/name?node=${node}`)).toMatchObject({ registrationPremiumLux: 42 })
    } else {
      expect(await request(store, '/treasury')).toMatchObject({ premiumReceivedLux: 100 })
      expect(await request(store, `/name?node=${node}`)).toMatchObject({ registrationPremiumLux: 100 })
    }
  } finally { provider?.indexer.close() }
})

it('updates SQLite prices from the cursor and router config without a new name event', async () => {
  const eventLogFile = await writeEventLog([registration, fees])
  const cursorFile = await writeCursor({ currentBlockHeight: grace, scannedBlockHeight: grace })
  const provider = await createIncrementalSqliteStore({ file: join(dirname(eventLogFile), 'index.sqlite'), eventLogFile, cursorFile })
  try {
    expect(await request(await provider(), '/search?query=aurora')).toMatchObject({ premiumLux: premium(0) })
    await writeCursor({ currentBlockHeight: grace + 8_640, scannedBlockHeight: grace + 8_640 }, cursorFile)
    expect(await request(await provider(), '/search?query=aurora')).toMatchObject({ premiumLux: premium(1) })
    await appendFile(eventLogFile, JSON.stringify({ ...fees, event: { ...fees.event, config: { ...DEFAULT_FEE_CONFIG, premiumStartLux: 0 } }, meta: { blockHeight: grace + 8_641, txId: 'disable' } }) + '\n')
    expect(await request(await provider(), '/search?query=aurora')).toMatchObject({ premiumLux: 0, premiumEndsAt: null, price: 10 })
  } finally { provider.indexer.close() }
})

it('excludes unregistered names, grace, reserved names and subnames, with a legacy date fallback', () => {
  const store = { feeConfig: DEFAULT_FEE_CONFIG }
  const clock = { blockHeight: grace, date: new Date(now) }
  for (const name of [null, { ...lifecycle, canonicalName: 'wallet.dusk' }, { ...lifecycle, canonicalName: 'pay.aurora.dusk' }, { ...lifecycle, issuedAsReserved: true }]) {
    expect(premiumForName(store, name, clock).premiumLux).toBe(0)
  }
  expect(premiumForName(store, lifecycle, { ...clock, blockHeight: grace - 1 }).premiumLux).toBe(0)
  expect(premiumForName(store, { ...lifecycle, graceEndsAtBlockHeight: null, graceEndsAt: '2026-10-02T12:00:00.000Z' }, { ...clock, blockHeight: null })).toMatchObject({ premiumLux: premium(1), premiumEndsAt: '2026-10-23T12:00:00.000Z', premiumEndsAtBlockHeight: null })
})

it.each(['replay', 'sqlite'])('keeps all ten day-zero registrations and exact statistics in %s', async mode => {
  const events = []
  const dayZero = premium(0)
  for (let i = 1; i <= 10; i++) {
    const nameNode = `0x${i.toString(16).padStart(64, '0')}`
    const old = { ...registration.event, node: nameNode, label: `premium${i}`, premiumLux: 0 }
    events.push({ event: old, meta: { blockHeight: i, txId: `old-${i}` } })
    events.push({ event: { ...old, premiumLux: dayZero, feeLux: dayZero + 10_000_000_000,
      expiresAtBlockHeight: grace + 1_000_000, graceEndsAtBlockHeight: grace + 1_100_000 },
      meta: { blockHeight: grace + i, txId: `new-${i}` } })
  }
  const total = (BigInt(dayZero) * 10n).toString()
  events.push({ event: { type: 'treasury_fee_received', amountLux: dayZero,
    totalReceivedLux: total, availableLux: total, registrationReceivedLux: total, renewalReceivedLux: 0, otherReceivedLux: 0 },
    meta: { blockHeight: grace + 11, txId: 'treasury' } })
  let store
  if (mode === 'replay') {
    const state = createReplayState(), warnings = []
    for (const event of events) applyReplayEvent(state, event, warnings)
    expect(warnings).toEqual([])
    store = finalizeReplayState(state, now, grace + 11)
  } else {
    const eventLogFile = await writeEventLog(events)
    const source = { file: join(dirname(eventLogFile), 'index.sqlite'), eventLogFile,
      cursorFile: await writeCursor({ currentBlockHeight: grace + 11, scannedBlockHeight: grace + 11 }) }
    const first = await createIncrementalSqliteStore(source)
    first.indexer.close()
    const reopened = await createIncrementalSqliteStore(source)
    try { store = await reopened() } finally { reopened.indexer.close() }
  }
  for (let i = 1; i <= 10; i++) {
    expect(await request(store, `/search?query=premium${i}`)).toMatchObject({ status: 'registered', premiumLux: 0 })
    expect(await request(store, `/name?node=0x${i.toString(16).padStart(64, '0')}`)).toMatchObject({ graceEndsAtBlockHeight: grace + 1_100_000, registrationPremiumLux: dayZero })
  }
  const treasury = await request(store, '/treasury')
  expect(treasury).toMatchObject({ premiumReceivedLux: total, totalReceivedLux: total, registrationReceivedLux: total })
  const snapshot = await loadSnapshotStore(await writeSnapshot({ treasury, names: [] }))
  expect(await request(snapshot, '/treasury')).toEqual(treasury)
})

it.each(['referrals', 'referralState'])('restores exact referral balances from %s snapshots', async key => {
  const store = await loadSnapshotStore(await writeSnapshot({ names: [], [key]: [{ referrer: node,
    claimableLux: '10000000000000001', claimedLux: '9007199254740993', referralCount: 1 }] }))
  expect(await request(store, `/referrals?referrer=${node}`)).toMatchObject({ claimableLux: '10000000000000001', claimedLux: '9007199254740993' })
})
