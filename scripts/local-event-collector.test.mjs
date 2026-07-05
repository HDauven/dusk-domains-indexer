import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadCollectorConfig,
  parseArgs,
  parseEnvFile,
  summarizeEventLogText,
  usage,
} from './local-event-collector.mjs'

const tempDirs = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('local event collector config', () => {
  it('parses CLI options used by the runbook', () => {
    expect(parseArgs([
      '--env-file',
      'local.env',
      '--event-log',
      'events.jsonl',
      '--cursor-file',
      'cursor.json',
      '--public-dir',
      'drivers',
      '--rusk-dir',
      '../rusk-private',
      '--node-url',
      'http://127.0.0.1:18180/',
      '--duration-ms',
      '2500',
      '--truncate',
    ])).toEqual({
      help: false,
      envFile: 'local.env',
      eventLog: 'events.jsonl',
      cursorFile: 'cursor.json',
      publicDir: 'drivers',
      ruskDir: '../rusk-private',
      nodeUrl: 'http://127.0.0.1:18180/',
      durationMs: 2500,
      truncate: true,
    })
  })

  it('keeps collector usage with the config surface', () => {
    expect(usage()).toContain('npm run indexer:collect')
    expect(usage()).toContain('--duration-ms')
    expect(usage()).toContain('resumes cursor event counts')
  })

  it('parses simple dotenv files with comments, quotes, and equals signs in values', () => {
    expect(parseEnvFile(`
      # local event collector
      VITE_DUSK_DOMAINS_NODE_URL="http://127.0.0.1:18180/"
      VITE_DUSK_DOMAINS_CORE_CONTRACT_ID='0x${'77'.repeat(32)}'
      VALUE_WITH_EQUALS=a=b=c
    `)).toEqual({
      VITE_DUSK_DOMAINS_NODE_URL: 'http://127.0.0.1:18180/',
      VITE_DUSK_DOMAINS_CORE_CONTRACT_ID: `0x${'77'.repeat(32)}`,
      VALUE_WITH_EQUALS: 'a=b=c',
    })
  })

  it('summarizes existing JSONL event logs for resumable collector cursors', () => {
    const summary = summarizeEventLogText(`
      {"event":{"type":"name_registered","node":"0x${'11'.repeat(32)}"},"meta":{"observedAt":"2026-06-17T20:00:00.000Z","contractKey":"registrar","txId":"0xaaa","blockHeight":7}}
      not json
      {"event":{"type":"record_changed","node":"0x${'11'.repeat(32)}"},"meta":{"observedAt":"2026-06-17T20:01:00.000Z","contractKey":"resolver","txId":"0xbbb","blockHeight":8}}
    `)

    expect(summary).toEqual({
      eventCount: 2,
      lastEventAt: '2026-06-17T20:01:00.000Z',
      lastContract: 'resolver',
      lastEventName: 'record_changed',
      lastTxId: '0xbbb',
      lastBlockHeight: 8,
      currentBlockHeight: 8,
      scannedBlockHeight: 8,
    })
  })

  it('summarizes JSON array event logs too', () => {
    expect(summarizeEventLogText(JSON.stringify([
      {
        event: { type: 'primary_name_changed', updatedAt: '2026-06-17T21:00:00.000Z' },
        meta: { contractKey: 'reverse' },
      },
    ]))).toMatchObject({
      eventCount: 1,
      lastEventAt: '2026-06-17T21:00:00.000Z',
      lastContract: 'reverse',
      lastEventName: 'primary_name_changed',
    })
  })

  it('loads configured contract IDs, driver paths, and W3sper config', async () => {
    const fixture = await createCollectorFixture()
    const config = await loadCollectorConfig({
      envFile: fixture.envFile,
      publicDir: fixture.publicDir,
      ruskDir: fixture.ruskDir,
      eventLog: fixture.eventLog,
      cursorFile: fixture.cursorFile,
      durationMs: 100,
      truncate: true,
    })

    expect(config.nodeUrl).toBe('http://127.0.0.1:18180/')
    expect(config.eventLog).toBe(fixture.eventLog)
    expect(config.cursorFile).toBe(fixture.cursorFile)
    expect(config.publicDir).toBe(fixture.publicDir)
    expect(config.denoConfig).toBe(join(fixture.ruskDir, 'w3sper.js', 'deno.json'))
    expect(config.durationMs).toBe(100)
    expect(config.truncate).toBe(true)
    expect(config.contracts.map((contract) => [contract.key, contract.contractId])).toEqual([
      ['core', '77'.repeat(32)],
      ['treasury', '66'.repeat(32)],
    ])
  })

  it('fails clearly when contract IDs are missing or malformed', async () => {
    const fixture = await createCollectorFixture({
      env: `
VITE_DUSK_DOMAINS_CORE_CONTRACT_ID=not-a-contract-id
`,
    })

    await expect(loadCollectorConfig({
      envFile: fixture.envFile,
      publicDir: fixture.publicDir,
      ruskDir: fixture.ruskDir,
    })).rejects.toThrow(/Missing or invalid contract IDs/)
  })

  it('fails clearly when a data-driver is missing', async () => {
    const fixture = await createCollectorFixture({
      skipDriver: 'dusk-domains-core.data-driver.wasm',
    })

    await expect(loadCollectorConfig({
      envFile: fixture.envFile,
      publicDir: fixture.publicDir,
      ruskDir: fixture.ruskDir,
    })).rejects.toThrow(/Missing data-driver WASM for core/)
  })
})

async function createCollectorFixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dusk-domains-collector-test-'))
  tempDirs.push(dir)

  const publicDir = join(dir, 'public', 'contracts')
  const ruskDir = join(dir, 'rusk-private')
  const w3sperDir = join(ruskDir, 'w3sper.js')
  const envFile = join(dir, '.env.local')
  const eventLog = join(dir, 'target', 'events.jsonl')
  const cursorFile = join(dir, 'target', 'cursor.json')

  await mkdir(publicDir, { recursive: true })
  await mkdir(w3sperDir, { recursive: true })
  await writeFile(join(w3sperDir, 'deno.json'), '{}\n', 'utf8')

  for (const driverFile of [
    'dusk-domains-core.data-driver.wasm',
    'dusk-domains-treasury.data-driver.wasm',
  ]) {
    if (driverFile !== options.skipDriver) {
      await writeFile(join(publicDir, driverFile), '', 'utf8')
    }
  }

  await writeFile(envFile, options.env ?? validEnv(), 'utf8')

  return {
    dir,
    publicDir,
    ruskDir,
    envFile,
    eventLog,
    cursorFile,
  }
}

function validEnv() {
  return `
VITE_DUSK_DOMAINS_NODE_URL=http://127.0.0.1:18180/
VITE_DUSK_DOMAINS_CORE_CONTRACT_ID=0x${'77'.repeat(32)}
VITE_DUSK_DOMAINS_TREASURY_CONTRACT_ID=0x${'66'.repeat(32)}
`
}
