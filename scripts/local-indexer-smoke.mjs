#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnvFile } from './env-file.mjs'
import { createSanitizedEventLogFixture } from './event-log-fixtures.mjs'
import { fetchJson, normalizeHttpBaseUrl, urlJoin } from './http-json.mjs'
import {
  checkRouteManifest,
  indexerHealthContract,
  probeRouteParameterErrors,
} from './local-indexer-smoke/routes.mjs'
import { createLocalIndexerHandler, createStaticLocalIndexerStore } from '../server/local-indexer.mjs'

const defaultEnvFile = '.env.local'
const defaultBaseUrl = 'http://127.0.0.1:8787'
const defaultName = 'aurora.dusk'
const defaultSnapshot = 'target/dusk-domains-local-indexer.json'
const defaultEventLog = 'target/dusk-domains-local-indexer.events.jsonl'
const defaultCursor = 'target/dusk-domains-local-indexer.cursor.json'
const defaultSqlite = 'target/dusk-domains-local-indexer.sqlite'
const preferredEnvPrefix = 'VITE_DUSK_DOMAINS'

if (isCliEntry()) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(usage())
    } else {
      const result = await smokeLocalIndexer(args)
      printResult(result, args.json)
      if (!result.ok) process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error('')
    console.error(usage())
    process.exitCode = 1
  }
}

export async function smokeLocalIndexer(options = {}) {
  const envFile = resolve(options.envFile ?? defaultEnvFile)
  const env = existsSync(envFile) ? parseEnvFile(await readFile(envFile, 'utf8')) : {}
  let source = indexerSourceFromOptions(options)
  const name = normalizeName(options.name ?? defaultName)
  const fetcher = options.fetch ?? globalThis.fetch

  if (!fetcher) throw new Error('local indexer smoke requires fetch.')

  let localServer = null
  let fixtureDir = null
  if (source?.mode === 'event-log') {
    source = await createSanitizedEventLogFixture(source)
    fixtureDir = source.fixtureDir ?? null
  } else if (source?.mode === 'sqlite' && source.eventLogFile) {
    const sanitized = await createSanitizedEventLogFixture({
      mode: 'event-log',
      file: source.eventLogFile,
      cursorFile: source.cursorFile,
    })
    source = {
      ...source,
      eventLogFile: sanitized.file,
      cursorFile: sanitized.cursorFile,
    }
    fixtureDir = sanitized.fixtureDir ?? null
  }
  const baseUrl = source
    ? (localServer = await startLocalIndexerServer(source, options.host ?? '127.0.0.1')).baseUrl
    : normalizeHttpBaseUrl(options.baseUrl ?? envValue(env, 'INDEXER_URL') ?? defaultBaseUrl, 'Indexer base URL')

  try {
    return await smokeLocalIndexerRoutes({
      envFile,
      baseUrl,
      name,
      fetcher,
      source,
    })
  } finally {
    await stopLocalIndexerServer(localServer)
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  }
}

async function smokeLocalIndexerRoutes({ envFile, baseUrl, name, fetcher, source }) {
  const checks = []

  const healthProbe = await fetchJson(fetcher, urlJoin(baseUrl, '/health'))
  const health = healthProbe.body
  const replayWarnings = Array.isArray(health?.warnings) ? health.warnings : []
  const healthContract = indexerHealthContract(health)
  pushCheck(checks, 'health', healthProbe.ok && health?.ok === true && healthContract.ok, healthProbe.ok
    ? healthContract.ok
      ? `Indexer healthy with ${health?.names ?? 0} indexed name(s), ${health?.eventCount ?? 0} event(s), lag ${health?.lagBlocks ?? 'unknown'} block(s)${replayWarnings.length ? `; ${replayWarnings.length} replay warning(s).` : '.'}`
      : healthContract.message
    : `Health failed: ${healthProbe.error ?? `HTTP ${healthProbe.status}`}`)

  const routeManifest = checkRouteManifest(health?.routes)
  pushCheck(checks, 'route_manifest', routeManifest.ok, routeManifest.message)

  const routeParameterErrors = await probeRouteParameterErrors(fetcher, baseUrl)
  pushCheck(checks, 'route_parameter_errors', routeParameterErrors.ok, routeParameterErrors.message)

  const searchProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/search?query=${encodeURIComponent(name)}`))
  pushCheck(checks, 'search', searchProbe.ok && searchProbe.body?.canonical === name, searchProbe.ok
    ? `Search returned ${searchProbe.body?.canonical ?? 'unknown'} with status ${searchProbe.body?.status ?? 'unknown'}.`
    : `Search failed: ${searchProbe.error ?? `HTTP ${searchProbe.status}`}`)

  const resolveProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/resolve?name=${encodeURIComponent(name)}`))
  const resolution = resolveProbe.body
  const moonlightRecord = resolution?.records?.find?.((record) => record.key === 'moonlight_address')
  pushCheck(checks, 'resolve', resolveProbe.ok && resolution?.canonicalName === name && resolution?.verificationStatus === 'forward_resolved', resolveProbe.ok
    ? `Forward resolution is ${resolution?.verificationStatus ?? 'unknown'}.`
    : `Forward resolution failed: ${resolveProbe.error ?? `HTTP ${resolveProbe.status}`}`)
  pushCheck(checks, 'resolve_warnings', resolveProbe.ok && Array.isArray(resolution?.warnings), resolveProbe.ok
    ? `/resolve returned ${Array.isArray(resolution?.warnings) ? resolution.warnings.length : 'invalid'} warning(s).`
    : `Forward warning metadata failed: ${resolveProbe.error ?? `HTTP ${resolveProbe.status}`}`)

  const node = resolution?.node
  if (node) {
    const nameProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/name?node=${encodeURIComponent(node)}`))
    pushCheck(checks, 'name', nameProbe.ok && nameProbe.body?.canonicalName === name, nameProbe.ok
      ? `/name returned ${nameProbe.body?.canonicalName ?? 'missing'}.`
      : `/name failed: ${nameProbe.error ?? `HTTP ${nameProbe.status}`}`)

    const activityProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/activity?node=${encodeURIComponent(node)}`))
    pushCheck(checks, 'activity', activityProbe.ok && Array.isArray(activityProbe.body), activityProbe.ok
      ? `/activity returned ${Array.isArray(activityProbe.body) ? activityProbe.body.length : 0} event(s).`
      : `/activity failed: ${activityProbe.error ?? `HTTP ${activityProbe.status}`}`)

    const subnamesProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/subnames?parentNode=${encodeURIComponent(node)}`))
    const subnames = Array.isArray(subnamesProbe.body) ? subnamesProbe.body : []
    pushCheck(checks, 'subnames', subnamesProbe.ok && Array.isArray(subnamesProbe.body), subnamesProbe.ok
      ? `/subnames returned ${subnames.length} subname(s).`
      : `/subnames failed: ${subnamesProbe.error ?? `HTTP ${subnamesProbe.status}`}`)

    if (subnames[0]?.node) {
      const subnameProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/subname?node=${encodeURIComponent(subnames[0].node)}`))
      pushCheck(checks, 'subname', subnameProbe.ok && subnameProbe.body?.node === subnames[0].node, subnameProbe.ok
        ? `/subname returned ${subnameProbe.body?.name ?? subnames[0].node}.`
        : `/subname failed: ${subnameProbe.error ?? `HTTP ${subnameProbe.status}`}`)

      const subnameName = subnameProbe.body?.canonicalName ?? subnameProbe.body?.name
      const subnameNameProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/name?node=${encodeURIComponent(subnames[0].node)}`))
      pushCheck(checks, 'subname_name', subnameNameProbe.ok && subnameNameProbe.body?.canonicalName === subnameName, subnameNameProbe.ok
        ? `/name returned ${subnameNameProbe.body?.canonicalName ?? 'missing'} for subname.`
        : `/name for subname failed: ${subnameNameProbe.error ?? `HTTP ${subnameNameProbe.status}`}`)

      const subnameSearchProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/search?query=${encodeURIComponent(subnameName)}`))
      pushCheck(checks, 'subname_search', subnameSearchProbe.ok && subnameSearchProbe.body?.status === 'registered', subnameSearchProbe.ok
        ? `/search returned ${subnameSearchProbe.body?.status ?? 'unknown'} for ${subnameName}.`
        : `/search for subname failed: ${subnameSearchProbe.error ?? `HTTP ${subnameSearchProbe.status}`}`)

      const subnameResolveProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/resolve?name=${encodeURIComponent(subnameName)}`))
      const subnameRecords = Array.isArray(subnameResolveProbe.body?.records) ? subnameResolveProbe.body.records : []
      const subnameLeakedParentMoonlight = Boolean(moonlightRecord && subnameRecords.some((record) => (
        record?.key === 'moonlight_address' && record?.value === moonlightRecord.value
      )))
      pushCheck(
        checks,
        'subname_resolve',
        subnameResolveProbe.ok
          && subnameResolveProbe.body?.canonicalName === subnameName
          && subnameResolveProbe.body?.node === subnames[0].node
          && subnameResolveProbe.body?.verificationStatus === 'forward_resolved'
          && !subnameLeakedParentMoonlight,
        subnameResolveProbe.ok
          && subnameLeakedParentMoonlight
          ? `/resolve for ${subnameName} leaked the parent Moonlight record.`
          : subnameResolveProbe.ok
            ? `/resolve returned ${subnameResolveProbe.body?.verificationStatus ?? 'unknown'} for ${subnameName}.`
            : `/resolve for subname failed: ${subnameResolveProbe.error ?? `HTTP ${subnameResolveProbe.status}`}`,
      )
    }
  } else {
    pushCheck(checks, 'name', false, 'Forward resolution did not return a node.')
    pushCheck(checks, 'activity', false, 'Forward resolution did not return a node.')
    pushCheck(checks, 'subnames', false, 'Forward resolution did not return a node.')
  }

  const namesProbe = await fetchJson(fetcher, urlJoin(baseUrl, '/names'))
  const names = Array.isArray(namesProbe.body) ? namesProbe.body : []
  const nameSummary = names.find((row) => row.canonicalName === name)
  const nameSummaryOk = namesProbe.ok && isNameSummaryFor(nameSummary, name, moonlightRecord, node)
  pushCheck(checks, 'names', nameSummaryOk, namesProbe.ok
    ? `/names returned ${names.length} name(s); ${name} status is ${nameSummary?.status ?? 'missing'}, primary is ${nameSummary?.primaryStatus ?? 'missing'}, node is ${nameSummary?.node ?? 'missing'}, with ${nameSummary?.records?.length ?? 0} record(s), ${nameSummary?.subnameCount ?? 0} subname(s), and ${nameSummary?.activityCount ?? 0} activity item(s).`
    : `/names failed: ${namesProbe.error ?? `HTTP ${namesProbe.status}`}`)

  const owner = nameSummary?.owner ?? nameSummary?.manager ?? null
  if (owner) {
    const ownedNamesProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/names?owner=${encodeURIComponent(owner)}`))
    const ownedNames = Array.isArray(ownedNamesProbe.body) ? ownedNamesProbe.body : []
    const ownedNameSummary = ownedNames.find((row) => row.canonicalName === name)
    pushCheck(checks, 'names_owner_filter', ownedNamesProbe.ok && isNameSummaryFor(ownedNameSummary, name, moonlightRecord, node), ownedNamesProbe.ok
      ? `/names owner filter returned ${ownedNames.length} name(s); ${name} status is ${ownedNameSummary?.status ?? 'missing'}, primary is ${ownedNameSummary?.primaryStatus ?? 'missing'}, node is ${ownedNameSummary?.node ?? 'missing'}, with ${ownedNameSummary?.records?.length ?? 0} record(s), ${ownedNameSummary?.subnameCount ?? 'missing'} subname(s), and ${ownedNameSummary?.activityCount ?? 'missing'} activity item(s).`
      : `/names owner filter failed: ${ownedNamesProbe.error ?? `HTTP ${ownedNamesProbe.status}`}`)

    const missingOwnerProbe = await fetchJson(fetcher, urlJoin(baseUrl, '/names?owner=0xmissing-local-smoke'))
    pushCheck(checks, 'names_missing_owner_filter', missingOwnerProbe.ok && Array.isArray(missingOwnerProbe.body) && missingOwnerProbe.body.length === 0, missingOwnerProbe.ok
      ? '/names missing-owner filter returned no names.'
      : `/names missing-owner filter failed: ${missingOwnerProbe.error ?? `HTTP ${missingOwnerProbe.status}`}`)
  } else {
    pushCheck(checks, 'names_owner_filter', false, `/names did not expose an owner or manager for ${name}.`)
    pushCheck(checks, 'names_missing_owner_filter', false, `/names did not expose an owner or manager for ${name}.`)
  }

  if (moonlightRecord) {
    const reverseProbe = await fetchJson(fetcher, urlJoin(baseUrl, `/reverse?type=moonlight_address&value=${encodeURIComponent(moonlightRecord.value)}`))
    pushCheck(checks, 'reverse', reverseProbe.ok && reverseProbe.body?.primaryName === name && (!node || reverseProbe.body?.node === node), reverseProbe.ok
      ? `/reverse returned ${reverseProbe.body?.primaryName ?? 'missing'} for node ${reverseProbe.body?.node ?? 'missing'}.`
      : `/reverse failed: ${reverseProbe.error ?? `HTTP ${reverseProbe.status}`}`)
  } else {
    pushCheck(checks, 'reverse', false, 'Forward resolution did not return a moonlight_address record.')
  }

  return {
    ok: checks.every((check) => check.ok),
    envFile,
    baseUrl,
    name,
    mode: health?.mode ?? null,
    indexedNames: health?.names ?? null,
    schemaVersion: health?.schemaVersion ?? null,
    eventCount: health?.eventCount ?? null,
    currentBlockHeight: health?.currentBlockHeight ?? null,
    finalizedBlockHeight: health?.finalizedBlockHeight ?? null,
    lagBlocks: health?.lagBlocks ?? null,
    lastEvent: health?.lastEvent ?? null,
    cursor: health?.cursor ?? null,
    checkpoint: health?.checkpoint ?? null,
    warnings: replayWarnings,
    source: source ?? null,
    node: node ?? null,
    checks,
  }
}

function pushCheck(checks, id, ok, message) {
  checks.push({ id, ok, message })
}

function isNameSummaryFor(summary, name, moonlightRecord, node) {
  if (!summary || summary.canonicalName !== name) return false
  const records = Array.isArray(summary.records) ? summary.records : []
  const summaryMoonlight = records.find((record) => record?.key === 'moonlight_address')

  return Boolean(
    summaryMoonlight
    && summary.status === 'active'
    && (!moonlightRecord || summaryMoonlight.value === moonlightRecord.value)
    && (!node || summary.node === node)
    && summary.primaryName === name
    && summary.primaryStatus === 'verified'
    && Number.isInteger(summary.subnameCount)
    && Number.isInteger(summary.activityCount),
  )
}

function normalizeName(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return defaultName
  return text.endsWith('.dusk') ? text : `${text}.dusk`
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(result.ok ? 'local-indexer: ready' : 'local-indexer: not ready')
  console.log(`base: ${result.baseUrl}`)
  console.log(`name: ${result.name}`)
  for (const check of result.checks) {
    console.log(`${check.ok ? 'ok' : 'fail'} ${check.id}: ${check.message}`)
  }
}

function usage() {
  return `Smoke-check the local Dusk Domains indexer API.

Usage:
  npm run check:indexer-local
  npm run check:indexer-local -- --base-url http://127.0.0.1:8787 --name aurora.dusk --json
  npm run check:indexer-local -- --event-log target/dusk-domains-local-indexer.events.jsonl
  npm run check:indexer-local -- --sqlite target/dusk-domains-local-indexer.sqlite --event-log target/dusk-domains-local-indexer.events.jsonl
  npm run check:indexer-local -- --snapshot target/dusk-domains-local-indexer.json

Options:
  --env-file <file>  Env file containing VITE_DUSK_DOMAINS_INDEXER_URL. Default: .env.local.
  --base-url <url>   Indexer base URL. Defaults to env or ${defaultBaseUrl}.
  --event-log <file> Start a temporary indexer by replaying this JSONL event log. Default path: ${defaultEventLog}.
  --sqlite <file>    Start a temporary indexer from a SQLite/WAL event store. With --event-log, rebuild/import the DB first.
  --snapshot <file>  Start a temporary indexer from this snapshot fallback. Default path: ${defaultSnapshot}.
  --cursor <file>    Optional collector cursor JSON for --event-log. Default: ${defaultCursor}.
  --host <host>      Host for temporary indexer mode. Default: 127.0.0.1.
  --name <name>      Name expected in the local indexer. Default: ${defaultName}.
  --json             Print machine-readable output.
  --help             Show this message.`
}

function envValue(env, suffix) {
  return env[`${preferredEnvPrefix}_${suffix}`]
}

function parseArgs(argv) {
  const parsed = {
    envFile: defaultEnvFile,
    baseUrl: '',
    name: defaultName,
    json: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--json') parsed.json = true
    else if (arg === '--env-file') parsed.envFile = requiredValue(argv, ++index, arg)
    else if (arg === '--base-url') parsed.baseUrl = requiredValue(argv, ++index, arg)
    else if (arg === '--event-log') parsed.eventLog = requiredValue(argv, ++index, arg)
    else if (arg === '--sqlite') parsed.sqlite = requiredValue(argv, ++index, arg)
    else if (arg === '--snapshot') parsed.snapshot = requiredValue(argv, ++index, arg)
    else if (arg === '--cursor') parsed.cursor = requiredValue(argv, ++index, arg)
    else if (arg === '--host') parsed.host = requiredValue(argv, ++index, arg)
    else if (arg === '--name') parsed.name = requiredValue(argv, ++index, arg)
    else throw new Error(`Unknown option: ${arg}`)
  }

  if (!parsed.baseUrl) delete parsed.baseUrl
  if (parsed.sqlite && parsed.snapshot) throw new Error('Use either --sqlite or --snapshot, not both')
  if (!parsed.sqlite && parsed.eventLog && parsed.snapshot) throw new Error('Use either --event-log or --snapshot, not both')
  return parsed
}

function indexerSourceFromOptions(options) {
  if (options.sqlite && options.snapshot) throw new Error('Use either sqlite or snapshot, not both.')
  if (!options.sqlite && options.eventLog && options.snapshot) throw new Error('Use either eventLog or snapshot, not both.')
  if (options.sqlite) {
    const file = options.sqlite === true ? defaultSqlite : options.sqlite
    const eventLogFile = options.eventLog
      ? resolve(options.eventLog === true ? defaultEventLog : options.eventLog)
      : ''
    return {
      mode: 'sqlite',
      file: resolve(file),
      eventLogFile,
      cursorFile: resolve(options.cursor ?? defaultCursor),
    }
  }
  if (options.eventLog) {
    const file = options.eventLog === true ? defaultEventLog : options.eventLog
    return {
      mode: 'event-log',
      file: resolve(file),
      cursorFile: resolve(options.cursor ?? defaultCursor),
    }
  }
  if (options.snapshot) {
    const file = options.snapshot === true ? defaultSnapshot : options.snapshot
    return {
      mode: 'snapshot',
      file: resolve(file),
    }
  }
  return null
}

async function startLocalIndexerServer(source, host) {
  const canCreateSqliteFromEventLog = source.mode === 'sqlite' && source.eventLogFile && existsSync(source.eventLogFile)
  if (!existsSync(source.file) && !canCreateSqliteFromEventLog) {
    const label = source.mode === 'snapshot'
      ? 'snapshot'
      : source.mode === 'sqlite'
        ? 'SQLite database'
        : 'event log'
    throw new Error(`Missing local indexer ${label}: ${source.file}. Generate a core/treasury indexer snapshot or event log first.`)
  }

  const storeProvider = await createStaticLocalIndexerStore(source)
  const server = createServer(createLocalIndexerHandler(storeProvider))
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    server,
    baseUrl: `http://${host}:${port}`,
  }
}

async function stopLocalIndexerServer(localServer) {
  if (!localServer?.server?.listening) return
  await new Promise((resolveClose) => {
    localServer.server.close(resolveClose)
  })
}

function requiredValue(argv, index, label) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`)
  return value
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
