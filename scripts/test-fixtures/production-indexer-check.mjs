import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDirs = []

export async function cleanupProductionIndexerFixtures() {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

export async function writeDurableFixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-names-production-indexer-test-'))
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
  const coreContractId = `0x${'44'.repeat(32)}`
  const treasuryContractId = options.treasuryContractId ?? `0x${'55'.repeat(32)}`
  const rows = [
    {
      event: {
        type: 'name_registered',
        node: `0x${'11'.repeat(32)}`,
        label: 'aurora',
        actor: `0x${'22'.repeat(32)}`,
        owner: `0x${'33'.repeat(32)}`,
        expiresAt: null,
        graceEndsAt: null,
        expiresAtBlockHeight: 1000,
        graceEndsAtBlockHeight: 1100,
        feeLux: 50_000_000_000,
      },
      meta: {
        txId: 'tx-register',
        ...(options.omitBlockHeight ? {} : { blockHeight: options.nullBlockHeight ? null : blockHeight }),
        contractKey: 'core',
        contractId: coreContractId,
        observedAt: '2026-06-22T00:00:00.000Z',
      },
    },
    {
      event: {
        type: 'treasury_initialized',
        operator: `0x${'66'.repeat(32)}`,
        operatorRecipient: 'recipient',
        allowedFeeSources: [coreContractId],
      },
      meta: {
        txId: 'tx-treasury',
        ...(options.omitBlockHeight ? {} : { blockHeight: options.nullBlockHeight ? null : blockHeight }),
        contractKey: 'treasury',
        contractId: treasuryContractId,
        observedAt: '2026-06-22T00:00:01.000Z',
      },
    },
    ...(options.legacyRow ? [{
      event: {
        type: 'record_changed',
        node: `0x${'11'.repeat(32)}`,
      },
      meta: {
        txId: 'tx-legacy',
        ...(options.omitBlockHeight ? {} : { blockHeight: options.nullBlockHeight ? null : blockHeight }),
        contractKey: 'resolver',
        contractId: `0x${'77'.repeat(32)}`,
        observedAt: '2026-06-22T00:00:02.000Z',
      },
    }] : []),
  ]
  await writeFile(eventLog, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  await writeFile(cursor, JSON.stringify({
    version: 1,
    source: 'w3sper-live-subscription',
    status: 'running',
    eventCount: rows.length,
    replayedEventCount: 0,
    startedAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:01:00.000Z',
    lastEventAt: '2026-06-22T00:00:00.000Z',
    lastContract: 'core',
    lastEventName: 'name_registered',
    lastTxId: 'tx-register',
    lastBlockHeight: blockHeight,
    currentBlockHeight,
    ...(options.scannedBlockHeight === undefined ? {} : { scannedBlockHeight: options.scannedBlockHeight }),
  }, null, 2), 'utf8')
  const envPrefix = options.legacyActiveEnv ? 'VITE_DUSK_NAMES' : 'VITE_DUSK_DOMAINS'
  await writeFile(envFile, `
${envPrefix}_CORE_CONTRACT_ID=${coreContractId}
${envPrefix}_TREASURY_CONTRACT_ID=0x${'55'.repeat(32)}
${envPrefix}_CORE_DRIVER_URL=/contracts/dusk-names-core.data-driver.wasm
${envPrefix}_TREASURY_DRIVER_URL=/contracts/dusk-name-treasury.data-driver.wasm
`, 'utf8')
  await writeFile(proofReport, JSON.stringify({
    ok: true,
    publicContracts: {
      core: coreContractId,
      treasury: `0x${'55'.repeat(32)}`,
    },
  }, null, 2), 'utf8')
  await writeFile(browserWriteProof, JSON.stringify({
    ok: true,
    generatedAt: '2026-06-22T00:02:00.000Z',
  }, null, 2), 'utf8')
  await writeFile(sqliteDb, 'sqliteDb\n', 'utf8')
  await writeFile(sqliteWal, 'sqliteWal\n', 'utf8')
  await writeFile(sqliteShm, 'sqliteShm\n', 'utf8')
  return { eventLog, cursor, checkpoint, archiveSnapshot, envFile, proofReport, browserWriteProof, sqliteDb, sqliteWal, sqliteShm, backupDir, restoreDir }
}
