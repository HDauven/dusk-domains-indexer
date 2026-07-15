#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const requiredRoutes = Object.freeze([
  '/health',
  '/search',
  '/resolve',
  '/name',
  '/records',
  '/record',
  '/record-history',
  '/names',
  '/activity',
  '/reverse',
  '/subnames',
  '/subname',
  '/treasury',
  '/referrals',
  '/fee-config',
  '/marketplace/config',
  '/marketplace/fixed-sales',
  '/marketplace/fixed-sale',
  '/marketplace/auctions',
  '/marketplace/auction',
  '/marketplace/offers',
  '/marketplace/offer',
  '/marketplace/refund',
])

if (isCliEntry()) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(usage())
    } else {
      const result = await probeIndexerHealth(args)
      await writeProbeOutput(result, args)
      if (!result.ok) process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

const defaultHealthUrl = healthUrlFromEnv(process.env)

export async function probeIndexerHealth(options = {}) {
  const args = normalizeOptions(options)
  const fetcher = options.fetch ?? globalThis.fetch
  if (!fetcher) throw new Error('Indexer health probe requires fetch.')

  const checks = []
  const push = (id, ok, message) => checks.push({ id, ok, message })
  let health = null

  try {
    const response = await fetcher(args.healthUrl, {
      headers: { accept: 'application/json' },
    })
    push('health_http', response.ok, response.ok
      ? `Health endpoint responded ${response.status}.`
      : `Health endpoint responded ${response.status}.`)
    health = await response.json()
  } catch (error) {
    push('health_http', false, `Could not reach health endpoint: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (health) {
    push('health_ok', health.ok === true, health.ok === true
      ? 'Indexer reports ok=true.'
      : `Indexer reports unsafe health: ${health.durability?.message ?? health.warnings?.[0]?.message ?? 'unknown reason'}`)
    push('schema_version', Number.isInteger(health.schemaVersion) && health.schemaVersion > 0, Number.isInteger(health.schemaVersion) && health.schemaVersion > 0
      ? `Schema version ${health.schemaVersion}.`
      : 'Health response is missing a positive schemaVersion.')
    push('event_count', Number(health.eventCount ?? 0) >= args.minEvents, Number(health.eventCount ?? 0) >= args.minEvents
      ? `Health reports ${health.eventCount ?? 0} event(s).`
      : `Health reports fewer than ${args.minEvents} event(s).`)
    const lag = Number.isFinite(Number(health.lagBlocks)) ? Number(health.lagBlocks) : null
    push('lag', lag !== null && lag <= args.maxLagBlocks, lag !== null && lag <= args.maxLagBlocks
      ? `Indexer lag is ${lag} block(s).`
      : `Indexer lag is ${lag === null ? 'unknown' : `${lag} block(s)`}; max allowed is ${args.maxLagBlocks}.`)
    if (args.maxSourceAgeMinutes !== null) {
      const sourceFreshness = sourceFreshnessFromHealth(health, args.now)
      const freshEnough = sourceFreshness.ageMinutes !== null && sourceFreshness.ageMinutes <= args.maxSourceAgeMinutes
      push('source_freshness', freshEnough, sourceFreshness.ageMinutes === null
        ? 'Health response is missing cursor/checkpoint source timestamps for freshness validation.'
        : `Indexer source was updated ${sourceFreshness.ageMinutes} minute(s) ago via ${sourceFreshness.source}; max allowed is ${args.maxSourceAgeMinutes}.`)
    }
    const missingRoutes = requiredRoutes.filter((route) => !health.routes?.includes(route))
    push('routes', missingRoutes.length === 0, missingRoutes.length === 0
      ? 'Health route manifest exposes all public routes.'
      : `Health route manifest is missing: ${missingRoutes.join(', ')}.`)
    push('last_event', Boolean(health.lastEvent?.eventName || health.lastEvent?.blockHeight), health.lastEvent?.eventName || health.lastEvent?.blockHeight
      ? `Last event ${health.lastEvent.eventName ?? 'unknown'} at block ${health.lastEvent.blockHeight ?? 'unknown'}.`
      : 'Health response is missing last-event metadata.')

    if (args.deploymentStartHeight !== null) {
      const currentBlockHeight = Number.isFinite(Number(health.currentBlockHeight)) ? Number(health.currentBlockHeight) : null
      const lastEventBlockHeight = Number.isFinite(Number(health.lastEvent?.blockHeight)) ? Number(health.lastEvent.blockHeight) : null
      push('current_height_after_deployment', currentBlockHeight !== null && currentBlockHeight >= args.deploymentStartHeight, currentBlockHeight === null
        ? 'Health response is missing current block height for deployment-height validation.'
        : currentBlockHeight >= args.deploymentStartHeight
          ? `Current block height ${currentBlockHeight} is at or after deployment start ${args.deploymentStartHeight}.`
          : `Current block height ${currentBlockHeight} predates deployment start ${args.deploymentStartHeight}.`)
      push('last_event_after_deployment', lastEventBlockHeight !== null && lastEventBlockHeight >= args.deploymentStartHeight, lastEventBlockHeight === null
        ? 'Health response is missing last-event block height for deployment-height validation.'
        : lastEventBlockHeight >= args.deploymentStartHeight
          ? `Last indexed event block ${lastEventBlockHeight} is at or after deployment start ${args.deploymentStartHeight}.`
          : `Last indexed event block ${lastEventBlockHeight} predates deployment start ${args.deploymentStartHeight}.`)
      push('archive_snapshot_height_configured', args.archiveSnapshotHeight !== null, args.archiveSnapshotHeight !== null
        ? `Archive snapshot height ${args.archiveSnapshotHeight} is configured.`
        : 'Deployment start height is configured, but archive snapshot height is missing.')
    }

    if (args.archiveSnapshotHeight !== null && args.deploymentStartHeight !== null) {
      push('archive_snapshot_height', args.archiveSnapshotHeight <= args.deploymentStartHeight, args.archiveSnapshotHeight <= args.deploymentStartHeight
        ? `Archive snapshot height ${args.archiveSnapshotHeight} covers deployment start ${args.deploymentStartHeight}.`
        : `Archive snapshot height ${args.archiveSnapshotHeight} is after deployment start ${args.deploymentStartHeight}.`)
    }
  }

  if (args.archiveSnapshot) {
    push('archive_snapshot_artifact', exists(args.archiveSnapshot), exists(args.archiveSnapshot)
      ? `Archive snapshot artifact exists: ${args.archiveSnapshot}`
      : `Missing archive snapshot artifact: ${args.archiveSnapshot}`)
  }

  const ok = checks.every((check) => check.ok)
  return {
    ok,
    healthUrl: args.healthUrl,
    maxLagBlocks: args.maxLagBlocks,
    maxSourceAgeMinutes: args.maxSourceAgeMinutes,
    minEvents: args.minEvents,
    deploymentStartHeight: args.deploymentStartHeight,
    archiveSnapshotHeight: args.archiveSnapshotHeight,
    archiveSnapshot: args.archiveSnapshot,
    generatedAt: new Date().toISOString(),
    health,
    checks,
    nextStep: ok
      ? 'Indexer health is safe for serving read traffic.'
      : 'Remove this indexer from write-confirmation paths, inspect collector/checkpoint state, and rerun the production indexer check.',
  }
}

export async function writeProbeOutput(result, options = {}) {
  const output = `${JSON.stringify(result, null, 2)}\n`
  if (options.out) {
    const file = resolve(options.out)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, output, 'utf8')
    return { writtenTo: file }
  }
  process.stdout.write(output)
  return { writtenTo: null }
}

export function parseArgs(argv, env = process.env) {
  const parsed = {
    help: false,
    healthUrl: healthUrlFromEnv(env),
    maxLagBlocks: 12,
    minEvents: 1,
    maxSourceAgeMinutes: null,
    deploymentStartHeight: null,
    archiveSnapshotHeight: null,
    archiveSnapshot: '',
    out: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--health-url') parsed.healthUrl = requiredValue(argv, ++index, arg)
    else if (arg === '--max-lag-blocks') parsed.maxLagBlocks = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--max-source-age-minutes') parsed.maxSourceAgeMinutes = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--min-events') parsed.minEvents = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--deployment-start-height') parsed.deploymentStartHeight = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--archive-snapshot-height') parsed.archiveSnapshotHeight = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--archive-snapshot') parsed.archiveSnapshot = requiredValue(argv, ++index, arg)
    else if (arg === '--out') parsed.out = requiredValue(argv, ++index, arg)
    else throw new Error(`Unknown option: ${arg}`)
  }
  return parsed
}

function normalizeOptions(options = {}) {
  return {
    healthUrl: String(options.healthUrl ?? defaultHealthUrl),
    maxLagBlocks: Number.isFinite(Number(options.maxLagBlocks)) ? Number(options.maxLagBlocks) : 12,
    maxSourceAgeMinutes: optionalNonNegativeInteger(options.maxSourceAgeMinutes),
    minEvents: Number.isFinite(Number(options.minEvents)) ? Number(options.minEvents) : 1,
    deploymentStartHeight: optionalNonNegativeInteger(options.deploymentStartHeight),
    archiveSnapshotHeight: optionalNonNegativeInteger(options.archiveSnapshotHeight),
    archiveSnapshot: String(options.archiveSnapshot ?? '').trim(),
    now: options.now ? new Date(options.now) : new Date(),
  }
}

function healthUrlFromEnv(env = process.env) {
  return env.DUSK_DOMAINS_INDEXER_HEALTH_URL
    ?? 'http://127.0.0.1:8787/health'
}

function parseNonNegativeInteger(value, label) {
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}

function optionalNonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

function exists(path) {
  return Boolean(path && existsSync(path))
}

function sourceFreshnessFromHealth(health, now) {
  const candidates = [
    ['cursor.updatedAt', health.cursor?.updatedAt],
    ['checkpoint.updatedAt', health.checkpoint?.updatedAt],
    ['lastEvent.observedAt', health.lastEvent?.observedAt],
  ]
  let latest = null
  for (const [source, value] of candidates) {
    const timestamp = Date.parse(String(value ?? ''))
    if (Number.isFinite(timestamp)) {
      if (!latest || timestamp > latest.timestamp) latest = { source, timestamp }
    }
  }
  if (latest) {
    const ageMinutes = Math.max(0, Math.floor((now.getTime() - latest.timestamp) / 60_000))
    return { source: latest.source, ageMinutes }
  }
  return { source: null, ageMinutes: null }
}

function requiredValue(argv, index, label) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`)
  return value
}

function usage() {
  return `Probe a running Dusk Domains indexer health endpoint.

Usage:
  npm run indexer:health

Options:
  --health-url <url>      Health endpoint. Default: DUSK_DOMAINS_INDEXER_HEALTH_URL or http://127.0.0.1:8787/health.
  --max-lag-blocks <n>    Maximum accepted indexer lag. Default: 12.
  --max-source-age-minutes <n>
                          Optional maximum age for cursor/checkpoint source timestamps.
  --min-events <n>        Minimum indexed events required. Default: 1.
  --deployment-start-height <n>
                          Optional deployment start height for launch-readiness validation.
  --archive-snapshot-height <n>
                          Optional archive snapshot height. Must be <= deployment start height when both are set.
  --archive-snapshot <path>
                          Optional retained archive-node snapshot artifact path to verify locally.
  --out <file>            Write the JSON proof artifact to a file.
  --help                  Show this message.`
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
