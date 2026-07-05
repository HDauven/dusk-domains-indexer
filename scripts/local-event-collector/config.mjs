import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export async function loadCollectorConfig(options = {}) {
  const envFile = resolve(rootDir, options.envFile ?? '.env.local')
  const env = existsSync(envFile) ? parseEnvFile(await readFile(envFile, 'utf8')) : {}
  const nodeUrl = options.nodeUrl
    ?? env.VITE_DUSK_DOMAINS_NODE_URL
    ?? 'http://127.0.0.1:18180/'
  const eventLog = resolve(rootDir, options.eventLog ?? 'target/dusk-domains-local-indexer.events.jsonl')
  const cursorFile = resolve(rootDir, options.cursorFile ?? 'target/dusk-domains-local-indexer.cursor.json')
  const publicDir = resolve(rootDir, options.publicDir ?? 'public/contracts')
  const ruskDir = resolve(rootDir, options.ruskDir ?? '../rusk-private-w3sper-contract-deploy')
  const w3sperDir = resolve(ruskDir, 'w3sper.js')
  const denoConfig = resolve(w3sperDir, 'deno.json')
  const configuredContracts = coreContracts.map((contract) => ({
    ...contract,
    contractId: normalizeContractId(env[contract.envKey]),
  }))
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

  if (!existsSync(denoConfig)) {
    throw new Error(`Missing W3sper Deno config: ${denoConfig}`)
  }

  return {
    envFile,
    nodeUrl,
    eventLog,
    cursorFile,
    publicDir,
    ruskDir,
    w3sperDir,
    denoConfig,
    durationMs: options.durationMs,
    truncate: Boolean(options.truncate),
    contractStack: 'core',
    contracts: configuredContracts,
  }
}

export function parseEnvFile(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const [key, ...rest] = line.split('=')
        return [key.trim(), unquote(rest.join('=').trim())]
      }),
  )
}

export function summarizeEventLogText(text) {
  const entries = parseEventLogEntries(text)
  let lastEntry = null

  for (const entry of entries) {
    if (entry?.event?.type) lastEntry = entry
  }

  const meta = lastEntry?.meta ?? {}
  const event = lastEntry?.event ?? {}
  return {
    eventCount: entries.length,
    lastEventAt: meta.observedAt ?? event.updatedAt ?? event.createdAt ?? event.observedAt ?? null,
    lastContract: meta.contractKey ?? null,
    lastEventName: event.type ?? null,
    lastTxId: meta.txId ?? null,
    lastBlockHeight: meta.blockHeight ?? null,
    currentBlockHeight: meta.blockHeight ?? null,
    scannedBlockHeight: meta.blockHeight ?? null,
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
    else if (arg === '--truncate') parsed.truncate = true
    else throw new Error(`Unknown option: ${arg}`)
  }

  if (!parsed.nodeUrl) delete parsed.nodeUrl
  if (parsed.durationMs === 0) delete parsed.durationMs

  return parsed
}

export function usage() {
  return `Collect decoded local Dusk Domains contract events into the local JSONL indexer log.

Usage:
  npm run indexer:collect
  npm run indexer:collect -- --event-log target/dusk-domains-local-indexer.events.jsonl
  npm run indexer:collect -- --duration-ms 30000

Options:
  --env-file <file>      Env file with local contract IDs. Default: .env.local.
  --event-log <file>     JSONL event log to append. Default: target/dusk-domains-local-indexer.events.jsonl.
  --cursor-file <file>   Collector status/cursor file. Default: target/dusk-domains-local-indexer.cursor.json.
  --public-dir <dir>     Directory containing data-driver WASM files. Default: public/contracts.
  --rusk-dir <dir>       Local rusk-private checkout. Default: ../rusk-private-w3sper-contract-deploy.
  --node-url <url>       Override VITE_DUSK_DOMAINS_NODE_URL from env.
  --duration-ms <n>      Stop automatically after n milliseconds. Default: run until SIGINT/SIGTERM.
  --truncate             Empty the event log before collecting.
  --help                 Show this message.

When appending to an existing event log, the collector resumes cursor event counts and last-event metadata from that log. Use --truncate for a fresh cursor.
`
}

function parseEventLogEntries(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed.filter(isEventLogEntry) : []
    } catch {
      return []
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(isEventLogEntry)
}

function isEventLogEntry(value) {
  return Boolean(value?.event?.type)
}

function normalizeContractId(value) {
  if (!value) return ''
  return String(value).trim().toLowerCase().replace(/^0x/, '')
}

function isContractId(value) {
  return /^[0-9a-f]{64}$/.test(value)
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function requiredValue(argv, index, label) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`)
  return value
}

function parseNonNegativeInteger(value, label) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}
