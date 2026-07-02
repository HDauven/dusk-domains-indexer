import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkIndexerDiskBudget,
  parseArgs,
  writeDiskBudgetArtifact,
} from './indexer-disk-budget.mjs'

const tempDirs = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('indexer disk budget check', () => {
  it('passes when live and backup paths are below warning threshold', async () => {
    const result = await checkIndexerDiskBudget({
      liveDir: '/var/lib/dusk-domains',
      backupDir: '/var/backups/dusk-domains',
      exists: () => true,
      statfs: () => statfs({ blocks: 100, bavail: 45 }),
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      warnPercent: 70,
      incidentPercent: 85,
    })
    expect(result.paths[0].usage.usedPercent).toBeCloseTo(55)
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'live_state_warn_threshold', ok: true }),
      expect.objectContaining({ id: 'backup_state_warn_threshold', ok: true }),
    ]))
  })

  it('fails when either path reaches the warning threshold', async () => {
    const result = await checkIndexerDiskBudget({
      exists: () => true,
      statfs: (path) => path.includes('backups')
        ? statfs({ blocks: 100, bavail: 20 })
        : statfs({ blocks: 100, bavail: 45 }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'backup_state_warn_threshold')).toMatchObject({
      ok: false,
      message: expect.stringContaining('80.0%'),
    })
    expect(result.checks.find((check) => check.id === 'backup_state_incident_threshold')).toMatchObject({
      ok: true,
    })
  })

  it('fails harder when a path reaches the incident threshold', async () => {
    const result = await checkIndexerDiskBudget({
      exists: () => true,
      statfs: (path) => path.includes('lib')
        ? statfs({ blocks: 100, bavail: 10 })
        : statfs({ blocks: 100, bavail: 45 }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === 'live_state_warn_threshold')).toMatchObject({
      ok: false,
    })
    expect(result.checks.find((check) => check.id === 'live_state_incident_threshold')).toMatchObject({
      ok: false,
      message: expect.stringContaining('85%'),
    })
  })

  it('fails when configured storage paths are missing', async () => {
    const result = await checkIndexerDiskBudget({
      exists: () => false,
      statfs: () => {
        throw new Error('not expected')
      },
    })

    expect(result.ok).toBe(false)
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'live_state_path', ok: false }),
      expect.objectContaining({ id: 'backup_state_path', ok: false }),
    ]))
  })

  it('writes JSON evidence when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-disk-budget-'))
    tempDirs.push(dir)
    const outFile = join(dir, 'disk-budget.json')
    const result = await checkIndexerDiskBudget({
      exists: () => true,
      statfs: () => statfs({ blocks: 100, bavail: 50 }),
    })

    await writeDiskBudgetArtifact(result, outFile)
    expect(JSON.parse(await readFile(outFile, 'utf8'))).toMatchObject({
      ok: true,
      paths: expect.any(Array),
    })
  })

  it('parses operator options', () => {
    expect(parseArgs([
      '--live-dir',
      '/live',
      '--backup-dir',
      '/backup',
      '--warn-percent',
      '65',
      '--incident-percent',
      '90',
      '--out',
      'disk.json',
      '--json',
    ])).toEqual({
      liveDir: '/live',
      backupDir: '/backup',
      warnPercent: 65,
      incidentPercent: 90,
      out: 'disk.json',
      json: true,
      help: false,
    })
  })
})

function statfs({ blocks, bavail }) {
  return {
    bsize: 1024,
    blocks,
    bavail,
  }
}
