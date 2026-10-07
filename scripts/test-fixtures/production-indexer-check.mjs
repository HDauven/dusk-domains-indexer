import { createEventLog, envelope, id, scope } from './frozen-events.mjs'
import { decodeReceipt } from '../../server/local-indexer/receipt-codec.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDirs = []

export async function cleanupProductionIndexerFixtures() {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

export async function writeDurableFixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-production-indexer-test-'))
  tempDirs.push(dir)
  const eventLog = join(dir, 'events.jsonl')
  const cursor = join(dir, 'cursor.json')
  const checkpoint = join(dir, 'checkpoint.json')
  const archiveSnapshot = join(dir, 'archive-snapshot.tar.zst')
  const envFile = join(dir, '.env.devnet.local')
  const proofReport = join(dir, 'proof.json')
  const browserWriteProof = join(dir, 'browser-proof.json')
  const sqliteDb = join(dir, 'indexer.sqlite')
  const sqliteWal = join(dir, 'indexer.sqlite-wal')
  const sqliteShm = join(dir, 'indexer.sqlite-shm')
  const backupDir = join(dir, 'backups')
  const restoreDir = join(dir, 'restore')
  const blockHeight = options.blockHeight ?? 10
  const currentBlockHeight = options.currentBlockHeight ?? 12
  const rows = createEventLog().slice(0, 4).map((entry, index) => {
    const r = decodeReceipt(entry.event.receipt)
    r.height = BigInt(blockHeight)
    for (const e of r.events) if (e.topic === 'operation_begin') e.data.height = r.height
    if (options.treasuryContractId) {
      for (const e of r.events) if (e.emitter === id(2)) {
        e.emitter = options.treasuryContractId.replace(/^0x/, '')
        if (e.data.call_path) e.data.call_path = [Array.from(Buffer.from(e.emitter, 'hex'))]
      }
    }
    const row = envelope(r)
    if (options.treasuryContractId) {
      delete row.event.projectionOptions.contracts[id(2)]
      row.event.projectionOptions.contracts[options.treasuryContractId.replace(/^0x/, '')] = 'vault'
    }
    if (options.omitBlockHeight) delete row.meta.blockHeight
    if (options.nullBlockHeight) row.meta.blockHeight = null
    return row
  })
  if (options.legacyRow) rows.push({ event: { type: 'old' }, meta: { contractKey: 'registrar', blockHeight } })
  await writeFile(eventLog, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  await writeFile(cursor, JSON.stringify({
    version: 2,
    source: 'rusk-finalized-archive',
    fromBlock: 1,
    scannedBlockHash: '11'.repeat(32),
    status: 'running',
    eventCount: rows.length,
    eventLogBytes: Buffer.byteLength(rows.map(row => JSON.stringify(row) + '\n').join('')),
    replayedEventCount: 0,
    startedAt: '2026-06-22T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    lastEventAt: '2026-06-22T00:00:00.000Z',
    lastContract: 'frozen',
    lastEventName: 'frozen_receipt',
    lastTxId: 'tx-register',
    lastBlockHeight: blockHeight,
    currentBlockHeight,
    scannedBlockHeight: options.scannedBlockHeight ?? currentBlockHeight,
  }, null, 2), 'utf8')
  const contracts = Object.fromEntries(Object.entries(scope).map(([id, role]) => [role, `0x${id}`]))
  await writeFile(envFile, Object.entries(contracts).map(([role, id]) => `DUSK_DOMAINS_${role.toUpperCase()}_CONTRACT_ID=${id}`).join('\n'))
  await writeFile(proofReport, JSON.stringify({ ok: true, publicContracts: contracts }))
  await writeFile(browserWriteProof, JSON.stringify({
    ok: true,
    generatedAt: '2026-06-22T00:02:00.000Z',
  }, null, 2), 'utf8')
  await writeFile(sqliteDb, 'sqliteDb\n', 'utf8')
  await writeFile(sqliteWal, 'sqliteWal\n', 'utf8')
  await writeFile(sqliteShm, 'sqliteShm\n', 'utf8')
  return { eventLog, cursor, checkpoint, archiveSnapshot, envFile, proofReport, browserWriteProof, sqliteDb, sqliteWal, sqliteShm, backupDir, restoreDir }
}
