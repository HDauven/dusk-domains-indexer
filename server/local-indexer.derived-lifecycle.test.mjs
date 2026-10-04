import { expect, it, vi } from 'vitest'
import { writeSnapshot, writeEventLog, writeCursor } from './local-indexer-test-helpers.mjs'
import { loadSnapshotStore } from './local-indexer/snapshot.mjs'
import { createIncrementalSqliteStore } from './local-indexer/incremental-sqlite-store.mjs'
import { join, dirname } from 'node:path'
import { appendFile, utimes } from 'node:fs/promises'
import { applyReplayEvent, createReplayState, finalizeReplayState } from './local-indexer/event-log-store.mjs'
import { createLocalIndexerHandler } from './local-indexer/routes.mjs'

const root = `0x${'01'.repeat(32)}`
const child = `0x${'02'.repeat(32)}`
const owner = `0x${'03'.repeat(32)}`
const marketplace = `0x${'99'.repeat(32)}`

function request(handler, url) {
  return new Promise((resolve) => {
    let status
    handler({ url, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, {
      writeHead(code) { status = code },
      end(body) { resolve({ status, body: body ? JSON.parse(body) : null }) },
    })
  })
}

function apply(state, event, blockHeight, meta = {}) {
  const warnings = []
  applyReplayEvent(state, { event, meta: { blockHeight, txId: `tx-${blockHeight}`, ...meta } }, warnings)
  expect(warnings).toEqual([])
}

function subnameState() {
  const state = createReplayState()
  apply(state, {
    type: 'name_registered', node: root, label: 'acme', actor: owner, owner,
    expiresAt: '2040-01-01T00:00:00.000Z', graceEndsAt: '2041-01-01T00:00:00.000Z',
    expiresAtBlockHeight: 1_000, graceEndsAtBlockHeight: 2_000,
  }, 1)
  apply(state, {
    type: 'subname_created', node: child, parentNode: root, name: 'pay.acme.dusk',
    parentName: 'acme.dusk', label: 'pay', actor: owner, owner, manager: owner,
    resolver: `0x${'04'.repeat(32)}`, expiresAt: '2030-01-01T00:00:00.000Z',
    expiresAtBlockHeight: 100, parentExpiresAt: '2040-01-01T00:00:00.000Z',
    parentExpiresAtBlockHeight: 1_000, expiryPolicy: 'fixed_before_parent',
    createdAt: '2029-01-01T00:00:00.000Z',
  }, 2)
  apply(state, {
    type: 'record_changed', node: child, controller: owner,
    record: { key: 'website', value: 'https://stale.example', visibility: 'public', ttlSeconds: 300,
      updatedAt: '2029-01-01T00:00:01.000Z' },
  }, 3)
  apply(state, {
    type: 'primary_name_changed', node: child, controller: owner, name: 'pay.acme.dusk',
    previousName: null, endpoint: { type: 'moonlight_address', value: 'dusk1staleendpoint000000000' },
    updatedAt: '2029-01-01T00:00:02.000Z',
  }, 4)

  return state
}

it('prunes derived state when a subname expires', async () => {
  const state = subnameState()
  const store = {
    ...finalizeReplayState(state, '2029-01-01T00:00:03.000Z', 100),
    cursor: { currentBlockHeight: 100, scannedBlockHeight: 100 },
  }
  const handler = createLocalIndexerHandler(store)
  const [subname, records, record, reverse] = await Promise.all([
    request(handler, `/subname?node=${child}`),
    request(handler, `/records?node=${child}`),
    request(handler, `/record?node=${child}&key=website`),
    request(handler, '/reverse?type=moonlight_address&value=dusk1staleendpoint000000000'),
  ])

  expect({
    subname: subname.body,
    records: records.body.records,
    record: record.body,
    reverse: reverse.body,
  }).toEqual({ subname: null, records: [], record: null, reverse: null })
})

it.each([99, 100, 109, 110])('uses indexed height %s for escrow on auction and fixed-sale routes', async (height) => {
  const state = createReplayState()
  apply(state, {
    type: 'name_registered', node: root, label: 'acme', actor: owner, owner,
    expiresAt: '2030-01-01T00:00:00.000Z', graceEndsAt: '2030-02-01T00:00:00.000Z',
    expiresAtBlockHeight: 100, graceEndsAtBlockHeight: 110,
  }, 1)
  apply(state, {
    type: 'domain_auction_created', auctionId: 1, node: root, name: 'acme.dusk', sellerAuthority: owner,
    reservePriceLux: 1_000_000_000, durationBlocks: 100, startDeadlineBlockHeight: 90,
    feeBps: 250, createdAtBlockHeight: 2,
  }, 2, { contractId: marketplace })
  const warnings = []
  applyReplayEvent(state, {
    event: {
      type: 'name_owner_changed', node: root, actor: owner, owner: marketplace,
      manager: marketplace, resolver: marketplace, expiresAt: '2030-01-01T00:00:00.000Z',
      expiresAtBlockHeight: 100,
    },
    meta: { blockHeight: 3, txId: 'tx-escrow' },
  }, warnings)
  expect(warnings).toEqual([])

  state.marketplaceFixedSalesByNode.set(root, { ...state.marketplaceAuctionsByNode.get(root) })
  const store = {
    ...finalizeReplayState(state, '2040-01-01T00:00:00.000Z', height),
    cursor: { currentBlockHeight: height, scannedBlockHeight: height },
  }
  const handler = createLocalIndexerHandler(store)
  for (const route of ['auction', 'fixed-sale']) {
    expect(await request(handler, `/marketplace/${route}?node=${root}`)).toMatchObject({
      status: 200, body: { node: root, escrowed: height < 110 },
    })
  }
  for (const [route, field] of [['auctions', 'auctions'], ['fixed-sales', 'fixedSales']]) {
    expect((await request(handler, `/marketplace/${route}`)).body[field]).toMatchObject([{ node: root, escrowed: height < 110 }])
  }
})

const leaf = `0x${'05'.repeat(32)}`
const endpoint = (node) => node === child ? 'dusk1staleendpoint000000000' : 'dusk1leafendpoint000000000'
const now = '2029-01-01T00:00:03.000Z'
const atHeight = (state, height) => ({ ...finalizeReplayState(state, now, height), cursor: { currentBlockHeight: height } })

function expiringParentState() {
  const state = subnameState()
  Object.assign(state.namesByNode.get(root), { expiresAtBlockHeight: 100, graceEndsAtBlockHeight: 110 })
  state.subnamesByNode.get(child).parentExpiresAtBlockHeight = 100
  return state
}

function eventsForState(state) {
  return [
    { type: 'name_registered', ...state.namesByNode.get(root), label: 'acme' },
    ...[...state.subnamesByNode.values()].map((row) => ({ ...row, type: 'subname_created' })),
    ...[...state.subnamesByNode.keys()].flatMap((node) => [
      { type: 'record_changed', node, controller: owner, record: state.recordsByNode.get(node)[0] },
      { type: 'primary_name_changed', ...state.reverseByEndpoint.get(`moonlight_address:${endpoint(node)}`), controller: owner },
    ]),
  ].map((event, index) => ({ event, meta: { blockHeight: index + 1, txId: `tx-${index}` } }))
}

const releaseParent = { type: 'name_released', node: root, label: 'acme', actor: owner, releasedAt: now }

function withDescendant() {
  const state = subnameState()
  apply(state, { ...state.subnamesByNode.get(child), type: 'subname_created', node: leaf,
    parentNode: child, name: 'tip.pay.acme.dusk', parentName: 'pay.acme.dusk', label: 'tip', expiresAtBlockHeight: 150 }, 5)
  apply(state, { type: 'record_changed', node: leaf, controller: owner,
    record: { key: 'website', value: 'https://leaf.example', visibility: 'public', ttlSeconds: 300, updatedAt: now } }, 6)
  apply(state, { type: 'primary_name_changed', node: leaf, controller: owner, name: 'tip.pay.acme.dusk',
    endpoint: { type: 'moonlight_address', value: endpoint(leaf) }, updatedAt: now }, 7)
  return state
}

async function expectIdentity(store, node, live, reverseNode = node) {
  const handler = createLocalIndexerHandler(store)
  expect((await request(handler, `/records?node=${node}`)).body.records).toHaveLength(live ? 1 : 0)
  const record = (await request(handler, `/record?node=${node}&key=website`)).body
  const reverse = (await request(handler, `/reverse?type=moonlight_address&value=${endpoint(node)}`)).body
  if (live) {
    expect(record).toMatchObject({ key: 'website' })
    expect(reverse).toMatchObject({ node: reverseNode })
  } else {
    expect(record).toBe(null)
    expect(reverse).toBe(null)
  }
}

it.each(['expired', 'inactive'])('clears %s subname identities and descendants while preserving capacity and replay state', async (reason) => {
  const state = withDescendant()
  const before = atHeight(state, 99)
  for (const node of [child, leaf]) await expectIdentity(before, node, true)
  if (reason === 'inactive') state.subnamesByNode.get(child).status = 'inactive'
  const after = atHeight(state, reason === 'expired' ? 100 : 99)
  for (const node of [child, leaf]) {
    expect(after.recordsByNode.has(node)).toBe(false)
    expect(after.recordsByNodeKey.has(`${node}\u0000website`)).toBe(false)
    expect(after.controllersByNode.has(node)).toBe(false)
    expect(after.reverseByEndpoint.has(`moonlight_address:${endpoint(node)}`)).toBe(false)
    expect(after.recordHistoryByNode.get(node)).toHaveLength(1)
    await expectIdentity(after, node, false)
    expect(state.recordsByNode.get(node)).toHaveLength(1)
    expect(state.reverseByEndpoint.has(`moonlight_address:${endpoint(node)}`)).toBe(true)
  }
  const rootName = (await request(createLocalIndexerHandler(after), `/name?node=${root}`)).body
  expect(rootName.namespace.descendantCount).toBe(2)
})

it.each([true, false])('checks cached route liveness with reverse node metadata %s', async (hasNode) => {
  const store = atHeight(withDescendant(), 99)
  if (!hasNode) for (const reverse of store.reverseByEndpoint.values()) delete reverse.node
  store.cursor.currentBlockHeight = 100
  for (const node of [child, leaf]) {
    expect(store.recordsByNode.get(node)).toHaveLength(1)
    await expectIdentity(store, node, false)
  }
})

it.each([
  [undefined, 'missing.dusk'],
  [undefined, 'missing.acme.dusk'],
  [`0x${'ff'.repeat(32)}`, 'pay.acme.dusk'],
])('rejects cached reverse entries for unknown node %s and name %s', async (node, primaryName) => {
  const store = atHeight(subnameState(), 99)
  Object.assign(store.reverseByEndpoint.get(`moonlight_address:${endpoint(child)}`), { node, primaryName, name: primaryName })
  expect(await request(createLocalIndexerHandler(store), `/reverse?type=moonlight_address&value=${endpoint(child)}`))
    .toEqual({ status: 200, body: null })
})

it.each([true, false])('keeps snapshot reverse entries cleared through parent grace end with node metadata %s', async (hasNode) => {
  const state = expiringParentState()
  for (const height of [99, 100, 109, 110]) {
    const file = await writeSnapshot({
      currentBlockHeight: height,
      names: [...state.namesByNode.values()],
      subnames: [{ ...state.subnamesByNode.get(child), records: state.recordsByNode.get(child) }],
      reverse: [...state.reverseByEndpoint.values()].map((row) => ({ ...row, node: hasNode ? row.node : undefined })),
    })
    const store = await loadSnapshotStore(file)
    expect(store.reverseByEndpoint.size, `height ${height}`).toBe(height < 100 ? 1 : 0)
    expect(store.subnamesByNode.size, `height ${height}`).toBe(height < 110 ? 1 : 0)
    await expectIdentity(store, child, height < 100, hasNode ? child : null)
  }
})

it.each([true, false])('clears snapshot reverse entries on parent release with node metadata %s', async (hasNode) => {
  const state = expiringParentState()
  const file = await writeSnapshot({
    currentBlockHeight: 99,
    names: [{ ...state.namesByNode.get(root), status: 'released' }],
    subnames: [{ ...state.subnamesByNode.get(child), records: state.recordsByNode.get(child) }],
    reverse: [...state.reverseByEndpoint.values()].map((row) => ({ ...row, node: hasNode ? row.node : undefined })),
  })
  const store = await loadSnapshotStore(file)
  expect(store.reverseByEndpoint.size).toBe(0)
  expect(store.subnamesByNode.size).toBe(0)
  await expectIdentity(store, child, false)
})

it.each([['active', 99], ['active', 109], ['active', 110], ['released', 99]])('checks node-less root reverse entries with status %s at height %s', async (status, height) => {
  const state = expiringParentState()
  const file = await writeSnapshot({
    currentBlockHeight: 99,
    names: [{ ...state.namesByNode.get(root), status }],
    reverse: [{ endpoint: { type: 'moonlight_address', value: endpoint(child) }, primaryName: 'acme.dusk' }],
  })
  const store = await loadSnapshotStore(file)
  expect(store.reverseByEndpoint.size).toBe(status === 'released' ? 0 : 1)
  store.checkpoint.lastBlockHeight = height
  const response = await request(createLocalIndexerHandler(store), `/reverse?type=moonlight_address&value=${endpoint(child)}`)
  expect(response).toEqual({ status: 200, body: status === 'released' || height >= 110
    ? null : { primaryName: 'acme.dusk', name: 'acme.dusk', node: null } })
})

it.each(['grace end', 'release'])('keeps replay reverse entries cleared through parent %s', async (boundary) => {
  const state = expiringParentState()
  for (const height of [99, 100, 109, 110]) {
    if (boundary === 'release' && height === 109) apply(state, releaseParent, height)
    const store = atHeight(state, height)
    expect(store.reverseByEndpoint.size, `height ${height}`).toBe(height < 100 ? 1 : 0)
    expect(store.subnamesByNode.size, `height ${height}`).toBe(height < (boundary === 'release' ? 109 : 110) ? 1 : 0)
    await expectIdentity(store, child, height < 100)
  }
})

it.each(['grace end', 'release'])('keeps incremental SQLite reverse entries cleared through parent %s and restart', async (boundary) => {
  const events = eventsForState(expiringParentState())
  const eventLogFile = await writeEventLog(events)
  const cursorFile = await writeCursor({ currentBlockHeight: 99, scannedBlockHeight: 99 })
  const source = { file: join(dirname(eventLogFile), 'indexer.sqlite'), eventLogFile, cursorFile }
  const provider = await createIncrementalSqliteStore(source)
  try {
    for (const height of [99, 100, 109, 110]) {
      if (boundary === 'release' && height === 109) {
        await appendFile(eventLogFile, `${JSON.stringify({ event: releaseParent, meta: { blockHeight: height, txId: 'tx-release' } })}\n`)
      }
      await writeCursor({ currentBlockHeight: height, scannedBlockHeight: height }, cursorFile)
      await utimes(cursorFile, height, height)
      const store = await provider()
      expect(store.reverseByEndpoint.size, `height ${height}`).toBe(height < 100 ? 1 : 0)
      expect(store.subnamesByNode.size, `height ${height}`).toBe(height < (boundary === 'release' ? 109 : 110) ? 1 : 0)
      await expectIdentity(store, child, height < 100)
    }
    expect(provider.indexer.stats).toMatchObject({ rebuilds: 1, viewBuilds: 3,
      appliedEvents: events.length + (boundary === 'release' ? 1 : 0) })
  } finally {
    provider.indexer.close()
  }
  const restarted = await createIncrementalSqliteStore(source)
  try {
    const store = await restarted()
    expect(store.reverseByEndpoint.size).toBe(0)
    expect(store.subnamesByNode.size).toBe(0)
    expect(restarted.indexer.stats.rebuilds).toBe(0)
    await expectIdentity(store, child, false)
  } finally {
    restarted.indexer.close()
  }
})

it.each([[99, true], [100, true], [99, false], [100, false]])('filters snapshot identities at height %s with reverse node metadata %s', async (height, hasNode) => {
  const state = withDescendant()
  const file = await writeSnapshot({
    currentBlockHeight: height,
    names: [...state.namesByNode.values()],
    subnames: [...state.subnamesByNode.values()].map((row) => ({ ...row, records: state.recordsByNode.get(row.node) })),
    reverse: [...state.reverseByEndpoint.values()].map((row) => ({ ...row, node: hasNode ? row.node : undefined })),
  })
  const store = await loadSnapshotStore(file)
  for (const node of [child, leaf]) {
    await expectIdentity(store, node, height < 100, hasNode ? node : null)
    expect(store.recordsByNode.has(node)).toBe(height < 100)
    if (height === 100) expect(store.subnamesByNode.get(node)).not.toHaveProperty('records')
  }
  expect(store.subnamesByNode.size).toBe(2)
})

it('clears subname identities when the collector cursor crosses expiry without a new event', async () => {
  const state = withDescendant()
  const events = eventsForState(state)
  const eventLogFile = await writeEventLog(events)
  const cursorFile = await writeCursor({ currentBlockHeight: 99, scannedBlockHeight: 99 })
  const source = { file: join(dirname(eventLogFile), 'indexer.sqlite'), eventLogFile, cursorFile }
  const provider = await createIncrementalSqliteStore(source)
  try {
    for (const node of [child, leaf]) await expectIdentity(await provider(), node, true)
    await writeCursor({ currentBlockHeight: 100, scannedBlockHeight: 100 }, cursorFile)
    const after = await provider()
    for (const node of [child, leaf]) {
      await expectIdentity(after, node, false)
      expect(after.recordsByNode.has(node)).toBe(false)
    }
    expect(provider.indexer.stats.viewBuilds).toBe(2)
    expect(provider.indexer.stats.appliedEvents).toBe(events.length)
  } finally {
    provider.indexer.close()
  }
  const restarted = await createIncrementalSqliteStore(source)
  try {
    for (const node of [child, leaf]) await expectIdentity(await restarted(), node, false)
  } finally {
    restarted.indexer.close()
  }
})

it('refreshes timestamp-only lifecycle cleanup even without a cursor update', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2029-12-31T23:59:59.000Z'))
  let provider
  try {
    const state = subnameState()
    const subname = state.subnamesByNode.get(child)
    const eventLogFile = await writeEventLog([
      { event: { ...state.namesByNode.get(root), type: 'name_registered', label: 'acme' } },
      { event: { ...subname, type: 'subname_created', expiresAtBlockHeight: null } },
      { event: { type: 'record_changed', node: child, controller: owner, record: state.recordsByNode.get(child)[0] } },
      { event: { ...state.reverseByEndpoint.values().next().value, type: 'primary_name_changed', controller: owner } },
    ])
    provider = await createIncrementalSqliteStore({ file: join(dirname(eventLogFile), 'indexer.sqlite'), eventLogFile })
    await expectIdentity(await provider(), child, true)
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    const store = await provider()
    expect(store.recordsByNode.has(child)).toBe(false)
    expect(store.reverseByEndpoint.size).toBe(0)
    await expectIdentity(store, child, false)
    expect(provider.indexer.stats.viewBuilds).toBe(2)
  } finally {
    provider?.indexer.close()
    vi.useRealTimers()
  }
})

it('rebuilds authority membership after transfers, reset, release and re-registration', async () => {
  const state = subnameState()
  const manager = `0x${'06'.repeat(32)}`
  const controller = `0x${'07'.repeat(32)}`
  const buyer = `0x${'08'.repeat(32)}`
  const list = async (store, authority) => (await request(createLocalIndexerHandler(store), `/names?owner=${authority}&limit=1`)).body.names
  apply(state, { type: 'record_changed', node: root, controller,
    record: { key: 'website', value: 'https://example.com', visibility: 'public', updatedAt: now } }, 8)
  let store = atHeight(state, 99)
  expect(store.namesByAuthority.get(controller)).toHaveLength(1)
  expect(await list(store, controller)).toMatchObject([{ node: root }])
  apply(state, { type: 'name_owner_changed', node: root, actor: owner, owner: buyer, manager,
    resolver: manager, dataCleared: true }, 9)
  store = atHeight(state, 99)
  expect(await list(store, owner)).toEqual([])
  expect(await list(store, controller)).toEqual([])
  for (const authority of [buyer, manager]) expect(await list(store, authority)).toMatchObject([{ node: root }])
  apply(state, { type: 'name_released', node: root, label: 'acme', actor: buyer, releasedAt: now }, 10)
  store = atHeight(state, 99)
  expect(store.namesByAuthority.size).toBe(0)
  expect(await list(store, buyer)).toEqual([])
  apply(state, { type: 'name_registered', node: root, label: 'acme', owner, actor: owner,
    expiresAtBlockHeight: 100, graceEndsAtBlockHeight: 110 }, 11)
  store = atHeight(state, 109)
  expect(await list(store, owner)).toMatchObject([{ node: root }])
  expect(await list(store, manager)).toEqual([])
  expect(atHeight(state, 110).namesByAuthority.size).toBe(0)
})

it('builds snapshot authority indexes from owners, managers and record controllers', async () => {
  const controller = `0x${'06'.repeat(32)}`
  const manager = `0x${'07'.repeat(32)}`
  const file = await writeSnapshot({ currentBlockHeight: 99, names: [{
    ...subnameState().namesByNode.get(root), manager,
    activity: [{ eventType: 'record_update', actor: controller }], records: [],
  }] })
  const store = await loadSnapshotStore(file)
  for (const authority of [owner, manager, controller]) {
    expect(store.namesByAuthority.get(authority)).toHaveLength(1)
    expect((await request(createLocalIndexerHandler(store), `/names?owner=${authority}`)).body.names).toMatchObject([{ node: root }])
  }
})
