import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  auditEventJournalDeploymentBinding,
  parseJournalEntries,
} from './event-journal-binding.mjs'

const tempDirs = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('indexer event journal deployment binding', () => {
  it('parses JSON array and JSONL journals while ignoring malformed lines', () => {
    expect(parseJournalEntries(JSON.stringify([{ meta: { contractKey: 'store' } }]))).toHaveLength(1)
    expect(parseJournalEntries([
      JSON.stringify({ meta: { contractKey: 'store' } }),
      'not json',
      JSON.stringify({ meta: { contractKey: 'vault' } }),
    ].join('\n'))).toEqual([
      { meta: { contractKey: 'store' } },
      { meta: { contractKey: 'vault' } },
    ])
    expect(parseJournalEntries('')).toEqual([])
  })

  it('binds the complete production journal to deployment evidence', async () => {
    const fixture = await writeJournalFixture()
    const result = await auditEventJournalDeploymentBinding({
      eventLog: fixture.eventLog,
      deployment: fixture.deployment,
      deploymentStartHeight: 10,
      deriveDeploymentStartHeight: false,
      archiveSnapshotHeight: 9,
      archiveSnapshot: fixture.archiveSnapshot,
      requireArchiveSnapshot: false,
      exists: (file) => file === fixture.archiveSnapshot,
    })

    expect(result.deploymentStartHeight).toBe(10)
    expect(result.derivedDeploymentStartHeight).toBe(10)
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'event_journal_contract_keys', ok: true }),
      expect.objectContaining({ id: 'event_journal_directory_contract', ok: true }),
      expect.objectContaining({ id: 'event_journal_directory_matches_deployment', ok: true }),
      expect.objectContaining({ id: 'event_journal_store_contract', ok: true }),
      expect.objectContaining({ id: 'event_journal_store_matches_deployment', ok: true }),
      expect.objectContaining({ id: 'event_journal_vault_contract', ok: true }),
      expect.objectContaining({ id: 'event_journal_vault_matches_deployment', ok: true }),
      expect.objectContaining({ id: 'event_journal_marketplace_contract', ok: true }),
      expect.objectContaining({ id: 'event_journal_marketplace_matches_deployment', ok: true }),
      expect.objectContaining({ id: 'archive_snapshot_height', ok: true }),
      expect.objectContaining({ id: 'archive_snapshot_file', ok: true }),
    ]))
  })

  it('reports legacy and unknown contract keys plus deployment mismatches', async () => {
    const fixture = await writeJournalFixture({
      treasuryContractId: `0x${'99'.repeat(32)}`,
      extraRows: [
        { meta: { contractKey: 'registrar', contractId: `0x${'77'.repeat(32)}`, blockHeight: 10 } },
        { meta: { contractKey: 'mystery', contractId: `0x${'88'.repeat(32)}`, blockHeight: 10 } },
      ],
    })
    const result = await auditEventJournalDeploymentBinding({
      eventLog: fixture.eventLog,
      deployment: fixture.deployment,
      deploymentStartHeight: 10,
      deriveDeploymentStartHeight: false,
      archiveSnapshotHeight: 9,
      archiveSnapshot: '',
      requireArchiveSnapshot: false,
    })

    expect(result.checks.find((check) => check.id === 'event_journal_contract_keys')).toMatchObject({
      ok: false,
      message: expect.stringContaining('legacy row 5'),
    })
    expect(result.checks.find((check) => check.id === 'event_journal_contract_keys')?.message).toContain('6:mystery')
    expect(result.checks.find((check) => check.id === 'event_journal_vault_matches_deployment')).toMatchObject({
      ok: false,
      message: expect.stringContaining('mismatch'),
    })
  })

  it('derives deployment start height and enforces archive retention evidence', async () => {
    const fixture = await writeJournalFixture({ blockHeight: 15 })
    const result = await auditEventJournalDeploymentBinding({
      eventLog: fixture.eventLog,
      deployment: fixture.deployment,
      deploymentStartHeight: null,
      deriveDeploymentStartHeight: true,
      archiveSnapshotHeight: 16,
      archiveSnapshot: '',
      requireArchiveSnapshot: true,
    })

    expect(result.deploymentStartHeight).toBe(15)
    expect(result.derivedDeploymentStartHeight).toBe(15)
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deployment_start_height_derived', ok: true }),
      expect.objectContaining({ id: 'archive_snapshot_required_deployment_start_height', ok: true }),
      expect.objectContaining({ id: 'archive_snapshot_required_height', ok: true }),
      expect.objectContaining({ id: 'archive_snapshot_required_file', ok: false }),
      expect.objectContaining({ id: 'archive_snapshot_height', ok: false }),
    ]))
  })

  it('flags event rows before an explicit deployment start height', async () => {
    const fixture = await writeJournalFixture({ blockHeight: 15 })
    const result = await auditEventJournalDeploymentBinding({
      eventLog: fixture.eventLog,
      deployment: fixture.deployment,
      deploymentStartHeight: 16,
      deriveDeploymentStartHeight: false,
      archiveSnapshotHeight: 15,
      archiveSnapshot: '',
      requireArchiveSnapshot: false,
    })

    expect(result.checks.find((check) => check.id === 'deployment_start_height')).toMatchObject({
      ok: false,
      message: expect.stringContaining('1:15'),
    })
  })
})

async function writeJournalFixture({
  blockHeight = 10,
  coreContractId = `0x${'44'.repeat(32)}`,
  treasuryContractId = `0x${'55'.repeat(32)}`,
  marketplaceContractId = `0x${'66'.repeat(32)}`,
  routerContractId = `0x${'33'.repeat(32)}`,
  extraRows = [],
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-event-journal-binding-'))
  tempDirs.push(dir)
  const eventLog = join(dir, 'events.jsonl')
  const archiveSnapshot = join(dir, 'archive-snapshot.tar.zst')
  const rows = [
    {
      meta: {
        contractKey: 'store',
        contractId: coreContractId,
        blockHeight,
      },
    },
    {
      meta: {
        contractKey: 'vault',
        contractId: treasuryContractId,
        blockHeight,
      },
    },
    {
      meta: {
        contractKey: 'marketplace',
        contractId: marketplaceContractId,
        blockHeight,
      },
    },
    {
      meta: {
        contractKey: 'directory',
        contractId: routerContractId,
        blockHeight,
      },
    },
    ...extraRows,
    { meta: { contractKey: 'policy', contractId: `0x${'aa'.repeat(32)}`, blockHeight } },
    { meta: { contractKey: 'resolver', contractId: `0x${'bb'.repeat(32)}`, blockHeight } },
  ]
  await writeFile(eventLog, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  await writeFile(archiveSnapshot, 'archive snapshot placeholder', 'utf8')
  return {
    eventLog,
    archiveSnapshot,
    deployment: {
      ok: true,
      contracts: {
        directory: routerContractId,
        policy: `0x${'aa'.repeat(32)}`,
        resolver: `0x${'bb'.repeat(32)}`,
        store: coreContractId,
        vault: `0x${'55'.repeat(32)}`,
        marketplace: marketplaceContractId,
      },
    },
  }
}
