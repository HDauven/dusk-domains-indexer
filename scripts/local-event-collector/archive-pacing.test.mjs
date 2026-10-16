import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { collectArchive } from './archive.mjs'
import { loadCollectorConfig, parseArgs, usage } from './config.mjs'
import { roles } from './frozen.mjs'
import { id } from '../test-fixtures/frozen-events.mjs'
import { collect, collected, collectorConfig, exampleChain, finalizedArchive, jsonDriver } from '../test-fixtures/finalized-archive.mjs'

const dirs = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const config = async (overrides = {}) => {
  const made = await collectorConfig(overrides)
  dirs.push(made.dir)
  return made.config
}

describe('pacing catch-up', () => {
  it('pauses between catch-up batches, and polls at the finalized head as before', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 20 }), c = await config({ batchSize: 4, catchUpPauseMs: 250 })
    const { waits } = await collect(archive, c, { polls: 3, onWait: ({ ms }) => { if (ms === 5000) archive.state.head += 1 } })
    expect(waits).toEqual([
      { ms: 250, status: 'catching-up', scanned: 4 }, { ms: 250, status: 'catching-up', scanned: 8 },
      { ms: 250, status: 'catching-up', scanned: 12 }, { ms: 250, status: 'catching-up', scanned: 16 },
      { ms: 5000, status: 'running', scanned: 20 }, { ms: 5000, status: 'running', scanned: 21 }, { ms: 5000, status: 'running', scanned: 22 },
    ])
    expect(archive.ranges()).toEqual([[1, 4], [5, 8], [9, 12], [13, 16], [17, 20], [21, 21], [22, 22]])
  })

  it('reads catch-up batches back to back with a pause of 0', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 20 }), c = await config({ batchSize: 4, catchUpPauseMs: 0 })
    expect((await collect(archive, c)).waits).toEqual([{ ms: 5000, status: 'running', scanned: 20 }])
    expect(archive.ranges()).toEqual([[1, 4], [5, 8], [9, 12], [13, 16], [17, 20]])
  })

  it('pauses 1 s between batches of 100 by default', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 250 }), c = await config()
    expect((await collect(archive, c)).waits).toEqual([{ ms: 1000, status: 'catching-up', scanned: 100 },
      { ms: 1000, status: 'catching-up', scanned: 200 }, { ms: 5000, status: 'running', scanned: 250 }])
    expect(archive.ranges()).toEqual([[1, 100], [101, 200], [201, 250]])
  })

  it('stops during a pause at the batch it committed, and a restart resumes there despite a crash tail', async () => {
    const reference = await config({ batchSize: 4, catchUpPauseMs: 250 })
    await collect(finalizedArchive(exampleChain(), { head: 20 }), reference)
    const archive = finalizedArchive(exampleChain(), { head: 20 }), c = await config({ batchSize: 4, catchUpPauseMs: 250 })
    const stopped = await collect(archive, c, { onWait: ({ ms, cursor, stop }) => { if (ms === 250 && cursor.scannedBlockHeight === 12) stop() } })
    // Receipts at blocks 1, 10, 11 and 12 are committed.
    expect(stopped.final).toMatchObject({ status: 'stopped', scannedBlockHeight: 12, eventCount: 4 })
    expect(archive.ranges()).toEqual([[1, 4], [5, 8], [9, 12]])
    // A crash after appending rows but before publishing their cursor leaves an uncommitted tail.
    await appendFile(c.eventLog, '{"uncommitted":')
    const resumed = await collect(archive, c)
    expect(resumed.cursor).toMatchObject({ status: 'running', scannedBlockHeight: 20, replayedEventCount: 4 })
    expect(archive.ranges()).toEqual([[1, 4], [5, 8], [9, 12], [13, 16], [17, 20]])
    expect(await collected(c)).toEqual(await collected(reference))
  })

  it('cancels the pause timer at once when stopped', async () => {
    const archive = finalizedArchive(exampleChain(), { head: 20 }), c = await config({ batchSize: 4, catchUpPauseMs: 5_000 })
    const controller = new AbortController(), started = Date.now(), pauses = []
    await collectArchive(c, { signal: controller.signal, fetcher: archive.fetcher, loadDriver: jsonDriver,
      wait: (ms, value, options) => {
        pauses.push(ms)
        // SIGTERM arrives while the real timer runs; the 5 s poll never comes in this test.
        setImmediate(() => controller.abort())
        return sleep(ms, value, options)
      } })
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(pauses).toEqual([5_000])
    expect(JSON.parse(await readFile(c.cursorFile, 'utf8'))).toMatchObject({ status: 'stopped', scannedBlockHeight: 4 })
  })

  it('keeps the batches before a failed read and retries at the poll interval, not the pause', async () => {
    const reference = await config({ batchSize: 4, catchUpPauseMs: 250 })
    await collect(finalizedArchive(exampleChain(), { head: 20 }), reference)
    const archive = finalizedArchive(exampleChain(), { head: 20 }), c = await config({ batchSize: 4, catchUpPauseMs: 250 })
    archive.state.faults.push({ matches: body => body.includes('checkBlock(height:9,'),
      response: { ok: true, status: 200, headers: new Headers(), json: async () => ({ errors: [{ message: 'checkBlock unavailable' }] }) } })
    const { waits, cursor } = await collect(archive, c, { polls: 2 })
    expect(waits).toEqual([
      { ms: 250, status: 'catching-up', scanned: 4 }, { ms: 250, status: 'catching-up', scanned: 8 },
      { ms: 5000, status: 'blocked', scanned: 8 },
      { ms: 250, status: 'catching-up', scanned: 12 }, { ms: 250, status: 'catching-up', scanned: 16 },
      { ms: 5000, status: 'running', scanned: 20 },
    ])
    expect(cursor.blocked).toBeUndefined()
    expect(await collected(c)).toEqual(await collected(reference))
  })

  it('refuses, when called directly, a batch Rusk cannot serve or a pause longer than the poll interval', async () => {
    for (const overrides of [{ batchSize: 0 }, { batchSize: 201 }, { batchSize: 1.5 }, { batchSize: '100' }, { batchSize: null },
      { catchUpPauseMs: -1 }, { catchUpPauseMs: 5_001 }, { catchUpPauseMs: 0.5 }, { catchUpPauseMs: '0' }, { catchUpPauseMs: null }]) {
      const archive = finalizedArchive(exampleChain(), { head: 20 })
      await expect(collect(archive, await config(overrides))).rejects.toThrow(/batch size|pause/)
      expect(archive.state.queries).toEqual([])
    }
    // Rusk 1.7.1 serves at most 200 blocks per range.
    const archive = finalizedArchive(exampleChain(), { head: 450 })
    expect((await collect(archive, await config({ batchSize: 200, catchUpPauseMs: 0 }))).cursor).toMatchObject({ status: 'running', scannedBlockHeight: 450 })
    expect(archive.ranges()).toEqual([[1, 200], [201, 400], [401, 450]])
  })
})

describe('collector tuning', () => {
  async function release() {
    const dir = (await collectorConfig()).dir; dirs.push(dir)
    const publicDir = join(dir, 'contracts'); await mkdir(publicDir)
    const bytes = Buffer.from('driver'), sha = createHash('sha256').update(bytes).digest('hex')
    const env = { DUSK_DOMAINS_FROM_BLOCK: '123', DUSK_DOMAINS_EVENT_SCHEMA_VERSION: '1', DUSK_DOMAINS_NODE_URL: 'http://node.invalid/', DUSK_DOMAINS_CHAIN_ID: 'dusk:1' }
    for (const [i, role] of roles.entries()) {
      const file = `${role}.${sha}.data-driver.wasm`; await writeFile(join(publicDir, file), bytes)
      env[`DUSK_DOMAINS_${role.toUpperCase()}_CONTRACT_ID`] = `0x${id(i + 1)}`
      env[`DUSK_DOMAINS_${role.toUpperCase()}_DRIVER_URL`] = `/contracts/${file}`
    }
    const envFile = join(dir, 'indexer.env')
    await writeFile(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'))
    return { dir, envFile, publicDir }
  }

  it('parses --batch-size and --catch-up-pause-ms, and rejects a batch Rusk cannot serve or a pause longer than the poll interval', () => {
    expect(parseArgs(['--batch-size', '50', '--catch-up-pause-ms', '0'])).toMatchObject({ batchSize: 50, catchUpPauseMs: 0 })
    expect(parseArgs(['--batch-size', '200', '--catch-up-pause-ms', '5000'])).toMatchObject({ batchSize: 200, catchUpPauseMs: 5000 })
    const parsed = parseArgs([])
    expect([parsed.batchSize, parsed.catchUpPauseMs]).toEqual([undefined, undefined])
    for (const value of ['0', '201', '-1', '1.5', 'abc', '1e2', ''])
      expect(() => parseArgs(['--batch-size', value]), value).toThrow('--batch-size')
    for (const value of ['5001', '60000', '-1', '0.5', 'abc', ''])
      expect(() => parseArgs(['--catch-up-pause-ms', value]), value).toThrow('--catch-up-pause-ms')
    expect(() => parseArgs(['--batch-size'])).toThrow('--batch-size requires a value')
    expect(usage()).toContain('--batch-size')
    expect(usage()).toContain('--catch-up-pause-ms')
  })

  it('defaults to 100 blocks and a 1 s pause, reads the collector env, and lets flags win', async () => {
    const r = await release()
    expect(await loadCollectorConfig({ envFile: r.envFile }, {})).toMatchObject({ batchSize: 100, catchUpPauseMs: 1000 })
    // An empty variable, as env files leave unset values, keeps the default.
    expect(await loadCollectorConfig({ envFile: r.envFile }, { DUSK_DOMAINS_COLLECTOR_BATCH_SIZE: '', DUSK_DOMAINS_COLLECTOR_CATCH_UP_PAUSE_MS: '' }))
      .toMatchObject({ batchSize: 100, catchUpPauseMs: 1000 })
    const env = { DUSK_DOMAINS_COLLECTOR_BATCH_SIZE: '25', DUSK_DOMAINS_COLLECTOR_CATCH_UP_PAUSE_MS: '0' }
    expect(await loadCollectorConfig({ envFile: r.envFile }, env)).toMatchObject({ batchSize: 25, catchUpPauseMs: 0 })
    expect(await loadCollectorConfig({ envFile: r.envFile, batchSize: 7, catchUpPauseMs: 250 }, env)).toMatchObject({ batchSize: 7, catchUpPauseMs: 250 })
    // The deployment env file may carry them too; the runtime environment wins.
    await appendFile(r.envFile, '\nDUSK_DOMAINS_COLLECTOR_BATCH_SIZE=40\nDUSK_DOMAINS_COLLECTOR_CATCH_UP_PAUSE_MS=500\n')
    expect(await loadCollectorConfig({ envFile: r.envFile }, {})).toMatchObject({ batchSize: 40, catchUpPauseMs: 500 })
    expect(await loadCollectorConfig({ envFile: r.envFile }, env)).toMatchObject({ batchSize: 25, catchUpPauseMs: 0 })
    for (const [key, value] of [['DUSK_DOMAINS_COLLECTOR_BATCH_SIZE', '0'], ['DUSK_DOMAINS_COLLECTOR_BATCH_SIZE', '500'],
      ['DUSK_DOMAINS_COLLECTOR_CATCH_UP_PAUSE_MS', '-5'], ['DUSK_DOMAINS_COLLECTOR_CATCH_UP_PAUSE_MS', '5001'],
      ['DUSK_DOMAINS_COLLECTOR_CATCH_UP_PAUSE_MS', 'soon']])
      await expect(loadCollectorConfig({ envFile: r.envFile }, { [key]: value })).rejects.toThrow(key)
  })

  it.each(['dusk-domains-collector.service', 'dusk-domains-collector@.service'])('runs the production command line of %s unchanged, with the defaults or the instance env', async name => {
    const r = await release()
    const unit = await readFile(new URL(`../../deploy/systemd/${name}`, import.meta.url), 'utf8')
    const command = unit.match(/^ExecStart=(.+)$/m)[1].split(/\s+/)
    const vars = { DUSK_DOMAINS_DEPLOYMENT_ENV_FILE: r.envFile, DUSK_DOMAINS_COLLECTOR_DRIVER_DIR: r.publicDir,
      DUSK_DOMAINS_INDEXER_EVENT_LOG: join(r.dir, 'events.jsonl'), DUSK_DOMAINS_INDEXER_CURSOR: join(r.dir, 'cursor.json') }
    const args = command.slice(command.findIndex(word => word.endsWith('/scripts/local-event-collector.mjs')) + 1)
      .map(word => word.replace(/^\$\{(\w+)\}$/, (_, name) => vars[name]))
    expect(args.some(word => word.includes('$'))).toBe(false)
    const instance = { DUSK_DOMAINS_COLLECTOR_NODE_URL: 'http://127.0.0.1:8080' }
    expect(await loadCollectorConfig(parseArgs(args), instance)).toMatchObject({ nodeUrl: 'http://127.0.0.1:8080', fromBlock: 123,
      eventLog: vars.DUSK_DOMAINS_INDEXER_EVENT_LOG, cursorFile: vars.DUSK_DOMAINS_INDEXER_CURSOR, batchSize: 100, catchUpPauseMs: 1000 })
    expect(await loadCollectorConfig(parseArgs(args), { ...instance, DUSK_DOMAINS_COLLECTOR_CATCH_UP_PAUSE_MS: '3000' }))
      .toMatchObject({ batchSize: 100, catchUpPauseMs: 3000 })
  })
})
