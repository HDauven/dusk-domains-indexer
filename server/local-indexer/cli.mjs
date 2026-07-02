import { pathToFileURL } from 'node:url'

export function parseArgs(argv, env = process.env) {
  const parsed = {
    help: false,
    snapshot: 'target/dusk-names-local-indexer.json',
    eventLog: '',
    sqlite: '',
    cursor: '',
    checkpoint: '',
    strictHealth: false,
    maxLagBlocks: 12,
    host: '127.0.0.1',
    port: 8787,
    corsOrigin: env.DUSK_DOMAINS_INDEXER_CORS_ORIGIN || '*',
    watch: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--snapshot') parsed.snapshot = requiredValue(argv, ++index, arg)
    else if (arg === '--event-log') parsed.eventLog = requiredValue(argv, ++index, arg)
    else if (arg === '--sqlite') parsed.sqlite = requiredValue(argv, ++index, arg)
    else if (arg === '--cursor') parsed.cursor = requiredValue(argv, ++index, arg)
    else if (arg === '--checkpoint') parsed.checkpoint = requiredValue(argv, ++index, arg)
    else if (arg === '--strict-health') parsed.strictHealth = true
    else if (arg === '--max-lag-blocks') parsed.maxLagBlocks = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--host') parsed.host = requiredValue(argv, ++index, arg)
    else if (arg === '--port') parsed.port = parsePort(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--cors-origin') parsed.corsOrigin = requiredValue(argv, ++index, arg)
    else if (arg === '--watch') parsed.watch = true
    else throw new Error(`Unknown option: ${arg}`)
  }

  if (parsed.sqlite && parsed.snapshot !== 'target/dusk-names-local-indexer.json') {
    throw new Error('Use either --sqlite or --snapshot, not both')
  }

  return parsed
}

export function isCliEntry(importMetaUrl, argv = process.argv) {
  return argv[1] && importMetaUrl === pathToFileURL(argv[1]).href
}

function requiredValue(argv, index, label) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`)
  return value
}

function parsePort(value, label) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} must be an unsigned integer`)
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error(`${label} must be between 1 and 65535`)
  return port
}

function parseNonNegativeInteger(value, label) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}
