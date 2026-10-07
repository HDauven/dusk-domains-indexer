import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { roles, topicsFor } from './local-event-collector/frozen.mjs'
import { loadCollectorConfig, parseArgs, parseEnvFile, usage, summarizeEventLogText } from './local-event-collector.mjs'
import { bootstrap, envelope, receipt, id } from './test-fixtures/frozen-events.mjs'
const dirs = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'frozen-config-')); dirs.push(dir)
  const publicDir = join(dir, 'contracts'); await mkdir(publicDir)
  const bytes = Buffer.from('driver'), sha = createHash('sha256').update(bytes).digest('hex')
  const env = { DUSK_DOMAINS_FROM_BLOCK: '123', DUSK_DOMAINS_EVENT_SCHEMA_VERSION: '1', DUSK_DOMAINS_NODE_URL: 'http://node.invalid/', DUSK_DOMAINS_CHAIN_ID: 'dusk:1' }
  for (const [i, role] of roles.entries()) {
    const file = `${role}.${sha}.data-driver.wasm`; await writeFile(join(publicDir, file), bytes)
    env[`DUSK_DOMAINS_${role.toUpperCase()}_CONTRACT_ID`] = `0x${id(i + 1)}`
    env[`DUSK_DOMAINS_${role.toUpperCase()}_DRIVER_URL`] = `/contracts/${file}`
  }
  const envFile = join(dir, 'indexer.env')
  const save = () => writeFile(envFile, Object.entries(env).map(([k,v]) => `${k}=${v}`).join('\n'))
  await save(); return { envFile, publicDir, env, save }
}
it('loads all frozen roles, immutable release drivers and first deployment block directly from indexer.env', async () => {
  const f = await fixture(), c = await loadCollectorConfig({ envFile: f.envFile }, {})
  expect(c).toMatchObject({ fromBlock: 123, chainId: 'dusk:1', eventSchemaVersion: '1', publicDir: f.publicDir, contractStack: 'frozen' })
  expect(c.contracts.map(x => x.key)).toEqual(roles)
  for (const contract of c.contracts) expect(contract.events).toEqual(topicsFor(contract.key))
})
it('preserves CLI and runtime override precedence and accepts frontend ID aliases', async () => {
  const f = await fixture()
  expect((await loadCollectorConfig({ envFile: f.envFile }, { DUSK_DOMAINS_NODE_URL: 'http://runtime.invalid/' })).nodeUrl).toBe('http://runtime.invalid/')
  expect((await loadCollectorConfig({ envFile: f.envFile, fromBlock: 120, nodeUrl: 'http://cli.invalid/' }, { DUSK_DOMAINS_COLLECTOR_NODE_URL: 'http://runtime.invalid/' }))).toMatchObject({ fromBlock: 120, nodeUrl: 'http://cli.invalid/' })
  for (const key of Object.keys(f.env)) if (key.endsWith('_CONTRACT_ID') || key.endsWith('_DRIVER_URL')) { f.env[`VITE_${key}`] = f.env[key]; delete f.env[key] }
  await f.save(); expect((await loadCollectorConfig({ envFile: f.envFile }, {})).contracts).toHaveLength(6)
})
it.each(['DUSK_DOMAINS_FROM_BLOCK','DUSK_DOMAINS_EVENT_SCHEMA_VERSION','DUSK_DOMAINS_DIRECTORY_CONTRACT_ID','DUSK_DOMAINS_STORE_DRIVER_URL'])('rejects a missing required %s', async key => {
  const f = await fixture(); delete f.env[key]; await f.save()
  await expect(loadCollectorConfig({ envFile: f.envFile }, {})).rejects.toThrow(key)
})
it('rejects modified immutable driver bytes', async () => {
  const f = await fixture(); await writeFile(join(f.publicDir, f.env.DUSK_DOMAINS_STORE_DRIVER_URL.split('/').at(-1)), 'changed')
  await expect(loadCollectorConfig({ envFile: f.envFile }, {})).rejects.toThrow('hash mismatch')
})
it('keeps first-block defaults in deployment env instead of overriding them from CLI defaults', () => {
  expect(parseArgs([]).fromBlock).toBeUndefined()
  expect(parseArgs(['--from-block', '5', '--public-dir', 'contracts', '--duration-ms', '2500', '--truncate'])).toMatchObject({ fromBlock: 5, durationMs: 2500, truncate: true })
  expect(() => parseArgs(['--from-block', '0'])).toThrow('positive')
  expect(() => parseArgs(['--from-block', '9007199254740993'])).toThrow('safe integer')
  expect(usage()).toContain('DUSK_DOMAINS_FROM_BLOCK')
})
it('parses quoted dotenv values and summarizes durable receipt rows', () => {
  expect(parseEnvFile('KEY="a=b#c" # comment')).toEqual({ KEY: 'a=b#c' })
  const entry = bootstrap()
  expect(summarizeEventLogText(JSON.stringify(entry) + '\n')).toMatchObject({ eventCount: 1, lastEventName: 'frozen_receipt', lastBlockHeight: 1 })
})
