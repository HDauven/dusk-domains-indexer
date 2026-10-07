import { roles, topicsFor } from './frozen.mjs'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnvFile } from '../env-file.mjs'

export { parseEnvFile } from '../env-file.mjs'
export { summarizeEventLogText } from './cursor-summary.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function loadCollectorConfig(options = {}, runtimeEnv = process.env) {
  const envFile = resolve(rootDir, options.envFile ?? '.env.local')
  const fileEnv = existsSync(envFile) ? parseEnvFile(await readFile(envFile, 'utf8')) : {}
  const env = { ...fileEnv, ...runtimeEnv }
  const value = key => env[`DUSK_DOMAINS_${key}`] ?? env[`VITE_DUSK_DOMAINS_${key}`]
  const publicDir = resolve(rootDir, options.publicDir ?? dirname(envFile) + '/contracts')
  const schema = value('EVENT_SCHEMA_VERSION')
  if (String(schema) !== '1') throw new Error('DUSK_DOMAINS_EVENT_SCHEMA_VERSION must be 1')
  const contracts = []
  for (const key of roles) {
    const prefix = key.toUpperCase()
    const contractId = normalizeContractId(value(`${prefix}_CONTRACT_ID`))
    if (!isContractId(contractId)) throw new Error(`Missing or invalid DUSK_DOMAINS_${prefix}_CONTRACT_ID in ${envFile}`)
    const url = value(`${prefix}_DRIVER_URL`)
    if (!url || !/^\/contracts\/[^/]+\.wasm$/.test(url))
      throw new Error(`DUSK_DOMAINS_${prefix}_DRIVER_URL must name /contracts/<immutable-file>.wasm`)
    const driverFile = url.slice('/contracts/'.length)
    const driverPath = resolve(publicDir, driverFile)
    const bytes = await readFile(driverPath)
    const driverHash = createHash('sha256').update(bytes).digest('hex')
    const expectedHash = driverFile.match(/\.([a-f0-9]{64})\.data-driver\.wasm$/)?.[1]
    if (!expectedHash || expectedHash !== driverHash) throw new Error(`Immutable driver hash mismatch: ${driverPath}`)
    contracts.push({ key, contractId, driverFile, driverHash, events: topicsFor(key) })
  }
  const fromBlock = parseNonNegativeInteger(String(options.fromBlock ?? value('FROM_BLOCK') ?? ''), 'DUSK_DOMAINS_FROM_BLOCK')
  if (fromBlock < 1) throw new Error('DUSK_DOMAINS_FROM_BLOCK must be positive')
  return {
    envFile, publicDir, fromBlock, eventSchemaVersion: '1', chainId: value('CHAIN_ID') ?? null,
    nodeUrl: options.nodeUrl ?? env.DUSK_DOMAINS_COLLECTOR_NODE_URL ?? value('NODE_URL') ?? 'http://127.0.0.1:18180/',
    eventLog: resolve(rootDir, options.eventLog ?? 'target/dusk-domains-local-indexer.events.jsonl'),
    cursorFile: resolve(rootDir, options.cursorFile ?? 'target/dusk-domains-local-indexer.cursor.json'),
    durationMs: options.durationMs, truncate: Boolean(options.truncate), contractStack: 'frozen', contracts,
  }
}

export function parseArgs(argv) {
  const parsed = {
    help: false,
    envFile: '.env.local',
    eventLog: 'target/dusk-domains-local-indexer.events.jsonl',
    cursorFile: 'target/dusk-domains-local-indexer.cursor.json',
    ruskDir: '../rusk-private-w3sper-contract-deploy',
    nodeUrl: '',
    durationMs: 0,
    truncate: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--env-file') parsed.envFile = requiredValue(argv, ++index, arg)
    else if (arg === '--event-log') parsed.eventLog = requiredValue(argv, ++index, arg)
    else if (arg === '--cursor-file') parsed.cursorFile = requiredValue(argv, ++index, arg)
    else if (arg === '--public-dir') parsed.publicDir = requiredValue(argv, ++index, arg)
    else if (arg === '--rusk-dir') parsed.ruskDir = requiredValue(argv, ++index, arg)
    else if (arg === '--node-url') parsed.nodeUrl = requiredValue(argv, ++index, arg)
    else if (arg === '--duration-ms') parsed.durationMs = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--from-block') {
      parsed.fromBlock = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
      if (parsed.fromBlock < 1) throw new Error('--from-block must be positive')
    }
    else if (arg === '--truncate') parsed.truncate = true
    else throw new Error(`Unknown option: ${arg}`)
  }

  if (!parsed.nodeUrl) delete parsed.nodeUrl
  if (parsed.durationMs === 0) delete parsed.durationMs

  return parsed
}

export function usage() {
  return `Collect finalized Dusk Domains events from a Rusk archive into a resumable JSONL journal.

Usage:
  npm run indexer:collect
  npm run indexer:collect -- --event-log target/dusk-domains-local-indexer.events.jsonl
  npm run indexer:collect -- --duration-ms 30000

Options:
  --env-file <file>      Deployment indexer.env file. Default: .env.local.
  --event-log <file>     JSONL event log to append. Default: target/dusk-domains-local-indexer.events.jsonl.
  --cursor-file <file>   Collector status/cursor file. Default: target/dusk-domains-local-indexer.cursor.json.
  --public-dir <dir>     Directory containing data-driver WASM files. Default: contracts/ beside the env file.
  --rusk-dir <dir>       Accepted for older launchers; no longer needed (Node.js decodes events).
  --node-url <url>       Archive node; requires lastBlockPair, blocks, contractEventBatch.
  --from-block <n>       First block to replay (at/before deployment). Default: DUSK_DOMAINS_FROM_BLOCK; retain on restart.
  --duration-ms <n>      Stop automatically after n milliseconds. Default: run until SIGINT/SIGTERM.
  --truncate             Discard the journal/cursor and replay again from --from-block.
  --help                 Show this message.

The collector resumes cursor event counts and finalized block hashes, including blocks missed offline.
Run ONE collector per journal. Legacy live/proof logs need NEW journal/cursor/SQLite paths: they cannot safely be deduplicated against archive events.
`
}

function normalizeContractId(value) {
  if (!value) return ''
  return String(value).trim().toLowerCase().replace(/^0x/, '')
}

function isContractId(value) {
  return /^[0-9a-f]{64}$/.test(value)
}

function requiredValue(argv, index, label) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`)
  return value
}

function parseNonNegativeInteger(value, label) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} must be a non-negative integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`${label} must be a safe integer`)
  return number
}
