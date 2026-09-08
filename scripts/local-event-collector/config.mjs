import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnvFile } from '../env-file.mjs'

export { parseEnvFile } from '../env-file.mjs'
export { summarizeEventLogText } from './cursor-summary.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const coreContracts = [
  {
    key: 'core',
    envKey: 'VITE_DUSK_DOMAINS_CORE_CONTRACT_ID',
    driverFile: 'dusk-domains-core.data-driver.wasm',
    events: [
      'registration_committed',
      'registration_revealed',
      'name_registered',
      'name_renewed',
      'name_owner_changed',
      'record_changed',
      'record_cleared',
      'primary_name_changed',
      'subname_created',
      'core_referral_config_changed',
      'fee_config_updated',
    ],
  },
  {
    key: 'treasury',
    envKey: 'VITE_DUSK_DOMAINS_TREASURY_CONTRACT_ID',
    driverFile: 'dusk-domains-treasury.data-driver.wasm',
    events: ['treasury_initialized', 'treasury_operator_changed', 'treasury_fee_received', 'treasury_claimed', 'referral_reward_accrued', 'referral_reward_claimed'],
  },
]

const optionalContracts = [
  {
    key: 'marketplace',
    envKey: 'VITE_DUSK_DOMAINS_MARKETPLACE_CONTRACT_ID',
    driverFile: 'dusk-domains-marketplace.data-driver.wasm',
    events: [
      'marketplace_initialized',
      'marketplace_config_updated',
      'domain_fixed_sale_opened',
      'domain_fixed_sale_closed',
      'domain_fixed_sale_filled',
      'domain_auction_created',
      'domain_bid_placed',
      'domain_auction_cancelled',
      'domain_auction_settled',
      'domain_offer_placed',
      'domain_offer_closed',
      'domain_offer_accepted',
      'marketplace_refund_claimed',
    ],
  },
]

export async function loadCollectorConfig(options = {}) {
  const envFile = resolve(rootDir, options.envFile ?? '.env.local')
  const env = existsSync(envFile) ? parseEnvFile(await readFile(envFile, 'utf8')) : {}
  const nodeUrl = options.nodeUrl
    ?? env.VITE_DUSK_DOMAINS_NODE_URL
    ?? 'http://127.0.0.1:18180/'
  const eventLog = resolve(rootDir, options.eventLog ?? 'target/dusk-domains-local-indexer.events.jsonl')
  const cursorFile = resolve(rootDir, options.cursorFile ?? 'target/dusk-domains-local-indexer.cursor.json')
  const publicDir = resolve(rootDir, options.publicDir ?? 'public/contracts')
  const requiredContracts = coreContracts.map((contract) => ({
    ...contract,
    contractId: normalizeContractId(env[contract.envKey]),
  }))
  const configuredOptionalContracts = optionalContracts
    .map((contract) => ({
      ...contract,
      contractId: normalizeContractId(env[contract.envKey]),
    }))
    .filter((contract) => Boolean(env[contract.envKey]))
  const configuredContracts = [...requiredContracts, ...configuredOptionalContracts]
  const missing = configuredContracts
    .filter((contract) => !isContractId(contract.contractId))
    .map((contract) => contract.envKey)

  if (missing.length > 0) {
    throw new Error(`Missing or invalid contract IDs in ${envFile}: ${missing.join(', ')}`)
  }

  for (const contract of configuredContracts) {
    const driverPath = resolve(publicDir, contract.driverFile)
    if (!existsSync(driverPath)) {
      throw new Error(`Missing data-driver WASM for ${contract.key}: ${driverPath}`)
    }
  }

  return {
    envFile,
    nodeUrl,
    eventLog,
    cursorFile,
    publicDir,
    fromBlock: options.fromBlock ?? 1,
    durationMs: options.durationMs,
    truncate: Boolean(options.truncate),
    contractStack: 'core',
    contracts: configuredContracts,
  }
}

export function parseArgs(argv) {
  const parsed = {
    help: false,
    envFile: '.env.local',
    eventLog: 'target/dusk-domains-local-indexer.events.jsonl',
    cursorFile: 'target/dusk-domains-local-indexer.cursor.json',
    publicDir: 'public/contracts',
    ruskDir: '../rusk-private-w3sper-contract-deploy',
    nodeUrl: '',
    durationMs: 0,
    fromBlock: 1,
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
  --env-file <file>      Env file with local contract IDs. Default: .env.local.
  --event-log <file>     JSONL event log to append. Default: target/dusk-domains-local-indexer.events.jsonl.
  --cursor-file <file>   Collector status/cursor file. Default: target/dusk-domains-local-indexer.cursor.json.
  --public-dir <dir>     Directory containing data-driver WASM files. Default: public/contracts.
  --rusk-dir <dir>       Accepted for older launchers; no longer needed (Node.js decodes events).
  --node-url <url>       Archive node; requires lastBlockPair, blocks, contractEventBatch.
  --from-block <n>       First block to replay (at/before deployment). Default: 1; retain on restart.
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
