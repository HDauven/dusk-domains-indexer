import { expect, it } from 'vitest'
import { normalizeObservedEvent } from '@duskdomains/sdk/projection'
import { loadSnapshotStore } from './snapshot.mjs'
import { replayEventLog } from './event-log-store.mjs'
import { searchName } from './read-models/search.mjs'
import { startServer, expectJson } from '../local-indexer-test-helpers.mjs'
import { loadCollectorConfig } from '../../scripts/local-event-collector/config.mjs'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const bytes = (value) => Array(32).fill(value)
const hex = (value) => `0x${value.toString(16).padStart(2, '0').repeat(32)}`
const observedAt = '2026-10-01T00:00:00.000Z'
const operator = { kind: 'Contract', bytes: bytes(7) }
function decode(eventName, event, key = 'core') {
  const result = normalizeObservedEvent({ contract: { key, contractId: hex(9) }, eventName, event, observedAt, observedBlockHeight: 100 })
  expect(result).not.toBeNull()
  return result
}
function issuance(label = 'wallet', owner = 2, at = 100) {
  return [
    decode('name_registered', { node: bytes(1), label, actor: bytes(9), owner: bytes(owner), expires_at: at + 100, grace_ends_at: at + 200, fee_lux: 0 }),
    decode('name_owner_changed', { node: bytes(1), actor: bytes(9), owner: bytes(owner), manager: bytes(3), resolver: bytes(0), expires_at: at + 100 }),
    decode('reserved_name_issued', { node: bytes(1), label, owner: bytes(owner), manager: bytes(3), registry: bytes(8), operator, issued_at: at }, 'router'),
  ]
}
function replay(events, height = 100) {
  const warnings = []
  const store = replayEventLog(events, warnings, observedAt, height)
  expect(warnings).toEqual([])
  // search uses the same confirmed tip as finalization.
  store.cursor = { currentBlockHeight: height }
  return store
}

it('decodes reserved provenance and exposes it with the owner on the name API', async () => {
  const events = issuance()
  expect(events[2]).toMatchObject({ event: { type: 'reserved_name_issued', actor: hex(7), operator, registry: hex(8), issuedAtBlockHeight: 100 }, meta: { blockHeight: 100 } })
  const store = replay(events)
  const server = await startServer(async () => store)
  try {
    expect(await expectJson(`${server.baseUrl}/name?node=${hex(1)}`)).toMatchObject({ owner: hex(2), manager: hex(3), issuedAsReserved: true, reservedIssuance: { operator, registry: hex(8), issuedAtBlockHeight: 100 } })
    expect(await expectJson(`${server.baseUrl}/search?query=wallet.dusk`)).toMatchObject({ status: 'registered', transactionBlocked: true })
  } finally { await server.close() }
})

it('shows issued roots as registered through grace, then reserved until re-issued', () => {
  for (const label of ['wallet', 'dusk']) {
    const events = issuance(label)
    expect(searchName(replay([]), label)).toMatchObject({ status: 'reserved', reserved: { label } })
    for (const at of [100, 200, 299]) {
      expect(searchName(replay(events, at), label)).toMatchObject({ status: 'registered', issues: [] })
    }
    expect(searchName(replay(events, 300), label)).toMatchObject({ status: 'reserved', transactionBlocked: true })
    const reissued = replay([...events, ...issuance(label, 4, 300)], 300)
    expect(searchName(reissued, label).status).toBe('registered')
    expect(reissued.namesByNode.get(hex(1))).toMatchObject({ owner: hex(4), issuedAsReserved: true, reservedIssuance: { issuedAtBlockHeight: 300 } })
  }
})

it('retains issuance provenance when an issued name renews or transfers', () => {
  const events = [...issuance(), decode('name_renewed', { node: bytes(1), actor: bytes(2), expires_at: 500, grace_ends_at: 600, fee_lux: 10 }), decode('name_owner_changed', { node: bytes(1), actor: bytes(2), owner: bytes(4), manager: bytes(5), resolver: bytes(0), expires_at: 500 })]
  const store = replay(events)
  expect(store.namesByNode.get(hex(1))).toMatchObject({ issuedAsReserved: true, reservedIssuance: { operator }, owner: hex(4), manager: hex(5), expiresAtBlockHeight: 500 })
})

it('subscribes to the router issuance event', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.reserved-collector-'))
  try {
    await mkdir(join(dir, 'contracts'))
    for (const contract of ['router', 'core', 'treasury']) await writeFile(join(dir, 'contracts', `dusk-domains-${contract}.data-driver.wasm`), '')
    await writeFile(join(dir, '.env'), ['ROUTER', 'CORE', 'TREASURY'].map((key) => `VITE_DUSK_DOMAINS_${key}_CONTRACT_ID=${hex(9)}`).join('\n'))
    const config = await loadCollectorConfig({ envFile: join(dir, '.env'), publicDir: join(dir, 'contracts') })
    expect(config.contracts.find((contract) => contract.key === 'router').events).toContain('reserved_name_issued')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('preserves issuance provenance when loading a snapshot', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.reserved-snapshot-'))
  try {
    const name = replay(issuance()).namesByNode.get(hex(1))
    const file = join(dir, 'snapshot.json')
    await writeFile(file, JSON.stringify({ currentBlockHeight: 100, names: [name] }))
    const snapshot = await loadSnapshotStore(file)
    expect(snapshot.namesByNode.get(hex(1))).toMatchObject({ issuedAsReserved: true, reservedIssuance: name.reservedIssuance })
    expect(searchName(snapshot, 'wallet.dusk').status).toBe('registered')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
