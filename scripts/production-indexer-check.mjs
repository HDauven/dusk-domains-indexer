#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyIndexerBackup } from './indexer-backup.mjs'
import { loadDeploymentSurface } from './indexer-operator/deployment-surface.mjs'
import { auditEventJournalDeploymentBinding } from './indexer-operator/event-journal-binding.mjs'
import {
  publicBetaEvidenceDefaults,
  readArchiveSnapshotMarker,
} from './indexer-operator/public-beta-evidence.mjs'
import { productionIndexerNextStep } from './indexer-operator/production-next-step.mjs'
import { checkSqliteServingProof } from './indexer-operator/sqlite-serving-proof.mjs'
import {
  createEventLogReplayCheckpoint,
  healthResponseForStore,
  loadEventLogStore,
  writeIndexerCheckpointFile,
} from '../server/local-indexer.mjs'

const defaultEventLog = 'target/dusk-names-devnet-indexer.events.jsonl'
const defaultCursor = 'target/dusk-names-devnet-indexer.cursor.json'
const defaultCheckpoint = 'target/dusk-names-devnet-indexer.checkpoint.json'
const defaultSqlite = 'target/dusk-names-devnet-indexer.sqlite'
const defaultEnvFile = '.env.devnet.local'
const defaultProofReport = 'target/dusk-names-devnet-proof.json'
const defaultArchiveSnapshot = publicBetaEvidenceDefaults.archiveSnapshot
const defaultBackupManifest = publicBetaEvidenceDefaults.backupManifest
const defaultBackupRestoreDir = publicBetaEvidenceDefaults.backupRestoreDir
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
])

if (isCliEntry()) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(usage())
    } else {
      const result = await checkProductionIndexer(args)
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

export async function checkProductionIndexer(options = {}) {
  const args = normalizeOptions(options)
  const exists = options.exists ?? existsSync
  const checks = []
  const push = (id, ok, message) => checks.push({ id, ok, message })

  push('event_log', exists(args.eventLog), exists(args.eventLog)
    ? `Event journal exists: ${args.eventLog}`
    : `Missing event journal: ${args.eventLog}`)
  push('cursor', exists(args.cursor), exists(args.cursor)
    ? `Collector cursor exists: ${args.cursor}`
    : `Missing collector cursor: ${args.cursor}`)

  let rebuilt = null
  if (args.rebuild && exists(args.eventLog)) {
    rebuilt = await createEventLogReplayCheckpoint(args.eventLog, args.now)
    await writeIndexerCheckpointFile(args.checkpoint, rebuilt.checkpoint)
  }

  push('checkpoint', exists(args.checkpoint), exists(args.checkpoint)
    ? `Replay checkpoint exists: ${args.checkpoint}`
    : `Missing replay checkpoint: ${args.checkpoint}${args.rebuild ? '' : ' Run with --rebuild first.'}`)

  let deployment = null
  if (exists(args.envFile) && exists(args.proofReport)) {
    try {
      deployment = await loadDeploymentSurface(args.envFile, args.proofReport)
      push('deployment_surface', deployment.ok, deployment.ok
        ? 'Deployment surface is bound to core and treasury contract IDs.'
        : deployment.message)
    } catch (error) {
      push('deployment_surface', false, `Could not read deployment surface: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    push('deployment_surface', false, `Missing deployment evidence: ${exists(args.envFile) ? '' : args.envFile}${exists(args.envFile) || exists(args.proofReport) ? '' : ', '}${exists(args.proofReport) ? '' : args.proofReport}`)
  }

  let journalBinding = null
  if (exists(args.eventLog)) {
    try {
      journalBinding = await auditEventJournalDeploymentBinding({
        eventLog: args.eventLog,
        deployment,
        deploymentStartHeight: args.deploymentStartHeight,
        deriveDeploymentStartHeight: args.deriveDeploymentStartHeight,
        archiveSnapshotHeight: args.archiveSnapshotHeight,
        archiveSnapshot: args.archiveSnapshot,
        requireArchiveSnapshot: args.requireArchiveSnapshot,
        exists,
      })
      for (const check of journalBinding.checks) checks.push(check)
    } catch (error) {
      push('event_journal_binding', false, `Could not audit event journal binding: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let health = null
  if (exists(args.eventLog)) {
    try {
      const store = await loadEventLogStore(args.eventLog, args.cursor, {
        checkpointFile: args.checkpoint,
        strictHealth: true,
        maxLagBlocks: args.maxLagBlocks,
      })
      health = healthResponseForStore(store)
      push('strict_health', health.ok === true, health.ok
        ? 'Strict indexer health is safe.'
        : health.durability?.message ?? 'Strict indexer health is unsafe.')
      push('event_count', Number(health.eventCount ?? 0) > 0, Number(health.eventCount ?? 0) > 0
        ? `Strict health reports ${health.eventCount} event(s).`
        : 'Strict health reports no indexed events.')
      const missingRoutes = requiredRoutes.filter((route) => !health.routes?.includes(route))
      push('route_manifest', missingRoutes.length === 0, missingRoutes.length === 0
        ? 'Health route manifest exposes all public indexer routes.'
        : `Health route manifest is missing: ${missingRoutes.join(', ')}.`)
      if (args.maxSourceAgeMinutes !== null) {
        const sourceFreshness = sourceFreshnessFromHealth(health, args.now)
        const freshEnough = sourceFreshness.ageMinutes !== null && sourceFreshness.ageMinutes <= args.maxSourceAgeMinutes
        push('source_freshness', freshEnough, sourceFreshness.ageMinutes === null
          ? 'Strict health is missing cursor/checkpoint source timestamps for freshness validation.'
          : `Strict health source was updated ${sourceFreshness.ageMinutes} minute(s) ago via ${sourceFreshness.source}; max allowed is ${args.maxSourceAgeMinutes}.`)
      }
    } catch (error) {
      push('strict_health', false, `Could not load strict indexer state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const sqliteProof = await checkSqliteServingProof({
    cursor: args.cursor,
    exists,
    maxLagBlocks: args.maxLagBlocks,
    requiredRoutes,
    requireSqlite: args.requireSqlite,
    sqlite: args.sqlite,
  })
  for (const check of sqliteProof.checks) checks.push(check)

  let backupVerification = null
  if (args.requireBackup) {
    push('backup_manifest_required', Boolean(args.backupManifest), args.backupManifest
      ? `Indexer backup manifest is configured: ${args.backupManifest}.`
      : 'Public beta backup policy requires --backup-manifest.')
    push('backup_restore_dir_required', Boolean(args.backupRestoreDir), args.backupRestoreDir
      ? `Indexer backup restore staging directory is configured: ${args.backupRestoreDir}.`
      : 'Public beta backup policy requires --backup-restore-dir to prove restore staging.')
  }
  if (args.backupManifest) {
    try {
      backupVerification = await (options.verifyIndexerBackup ?? verifyIndexerBackup)({
        manifest: args.backupManifest,
        restoreDir: args.backupRestoreDir || null,
        requireSqlite: args.requireSqliteBackup,
      })
      push('backup_manifest_verification', backupVerification.ok === true, backupVerification.ok
        ? 'Indexer backup manifest verifies successfully.'
        : 'Indexer backup manifest verification failed.')
      for (const check of backupVerification.checks ?? []) {
        checks.push({
          id: `backup_${check.id}`,
          ok: check.ok,
          message: check.message,
        })
      }
    } catch (error) {
      push('backup_manifest_verification', false, `Could not verify indexer backup manifest: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const nextStep = productionIndexerNextStep({
    checks,
    requireSqliteBackup: args.requireSqliteBackup,
  })
  return {
    ok: checks.every((check) => check.ok),
    eventLog: args.eventLog,
    cursor: args.cursor,
    checkpoint: args.checkpoint,
    sqlite: args.sqlite,
    envFile: args.envFile,
    proofReport: args.proofReport,
    maxLagBlocks: args.maxLagBlocks,
    maxSourceAgeMinutes: args.maxSourceAgeMinutes,
    deploymentStartHeight: journalBinding?.deploymentStartHeight ?? args.deploymentStartHeight,
    derivedDeploymentStartHeight: journalBinding?.derivedDeploymentStartHeight ?? null,
    archiveSnapshotHeight: args.archiveSnapshotHeight,
    archiveSnapshot: args.archiveSnapshot,
    backupManifest: args.backupManifest,
    backupRestoreDir: args.backupRestoreDir,
    requireSqliteBackup: args.requireSqliteBackup,
    requireSqlite: args.requireSqlite,
    backupVerification: backupVerification
      ? {
          ok: backupVerification.ok,
          manifest: backupVerification.manifest,
          restoreDir: backupVerification.restoreDir,
          restoredCount: Array.isArray(backupVerification.restored) ? backupVerification.restored.length : 0,
        }
      : null,
    rebuilt: rebuilt
      ? {
          eventCount: rebuilt.eventCount,
          rawEventCount: rebuilt.rawEventCount,
          warningCount: rebuilt.warnings.length,
        }
      : null,
    health,
    sqliteHealth: sqliteProof.sqliteHealth,
    checks,
    nextStep,
  }
}

function normalizeOptions(options = {}) {
  const archiveSnapshot = options.archiveSnapshot ? resolve(options.archiveSnapshot) : ''
  const archiveMarker = readArchiveSnapshotMarker(archiveSnapshot)
  return {
    eventLog: resolve(options.eventLog ?? defaultEventLog),
    cursor: resolve(options.cursor ?? defaultCursor),
    checkpoint: resolve(options.checkpoint ?? defaultCheckpoint),
    sqlite: options.sqlite ? resolve(options.sqlite) : (options.requireSqlite ? resolve(defaultSqlite) : ''),
    envFile: resolve(options.envFile ?? defaultEnvFile),
    proofReport: resolve(options.proofReport ?? defaultProofReport),
    archiveSnapshot,
    backupManifest: options.backupManifest ? resolve(options.backupManifest) : '',
    backupRestoreDir: options.backupRestoreDir ? resolve(options.backupRestoreDir) : '',
    requireArchiveSnapshot: Boolean(options.requireArchiveSnapshot),
    requireBackup: Boolean(options.requireBackup),
    requireSqliteBackup: Boolean(options.requireSqliteBackup),
    requireSqlite: Boolean(options.requireSqlite),
    deriveDeploymentStartHeight: Boolean(options.deriveDeploymentStartHeight),
    maxLagBlocks: Number.isFinite(Number(options.maxLagBlocks)) ? Number(options.maxLagBlocks) : 12,
    maxSourceAgeMinutes: optionalNonNegativeInteger(options.maxSourceAgeMinutes),
    deploymentStartHeight: optionalNonNegativeInteger(options.deploymentStartHeight),
    archiveSnapshotHeight: optionalNonNegativeInteger(options.archiveSnapshotHeight)
      ?? optionalNonNegativeInteger(archiveMarker?.archiveSnapshotHeight),
    rebuild: Boolean(options.rebuild),
    now: options.now ?? new Date().toISOString(),
  }
}

export function parseArgs(argv) {
  const parsed = {
    eventLog: defaultEventLog,
    cursor: defaultCursor,
    checkpoint: defaultCheckpoint,
    sqlite: '',
    envFile: defaultEnvFile,
    proofReport: defaultProofReport,
    maxLagBlocks: 12,
    maxSourceAgeMinutes: null,
    deploymentStartHeight: null,
    archiveSnapshotHeight: null,
    archiveSnapshot: '',
    backupManifest: '',
    backupRestoreDir: '',
    requireArchiveSnapshot: false,
    requireBackup: false,
    requireSqliteBackup: false,
    requireSqlite: false,
    deriveDeploymentStartHeight: false,
    rebuild: false,
    json: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--json') parsed.json = true
    else if (arg === '--rebuild') parsed.rebuild = true
    else if (arg === '--event-log') parsed.eventLog = requiredValue(argv, ++index, arg)
    else if (arg === '--cursor') parsed.cursor = requiredValue(argv, ++index, arg)
    else if (arg === '--checkpoint') parsed.checkpoint = requiredValue(argv, ++index, arg)
    else if (arg === '--sqlite') parsed.sqlite = requiredValue(argv, ++index, arg)
    else if (arg === '--env-file') parsed.envFile = requiredValue(argv, ++index, arg)
    else if (arg === '--proof-report') parsed.proofReport = requiredValue(argv, ++index, arg)
    else if (arg === '--archive-snapshot') parsed.archiveSnapshot = requiredValue(argv, ++index, arg)
    else if (arg === '--backup-manifest') parsed.backupManifest = requiredValue(argv, ++index, arg)
    else if (arg === '--backup-restore-dir') parsed.backupRestoreDir = requiredValue(argv, ++index, arg)
    else if (arg === '--require-archive-snapshot') parsed.requireArchiveSnapshot = true
    else if (arg === '--require-backup') parsed.requireBackup = true
    else if (arg === '--require-sqlite-backup') parsed.requireSqliteBackup = true
    else if (arg === '--require-sqlite') parsed.requireSqlite = true
    else if (arg === '--derive-deployment-start-height') parsed.deriveDeploymentStartHeight = true
    else if (arg === '--max-lag-blocks') parsed.maxLagBlocks = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--max-source-age-minutes') parsed.maxSourceAgeMinutes = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--deployment-start-height') parsed.deploymentStartHeight = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--archive-snapshot-height') parsed.archiveSnapshotHeight = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else throw new Error(`Unknown option: ${arg}`)
  }

  if (parsed.requireArchiveSnapshot && !parsed.archiveSnapshot) parsed.archiveSnapshot = defaultArchiveSnapshot
  if (parsed.requireBackup && !parsed.backupManifest) parsed.backupManifest = defaultBackupManifest
  if (parsed.requireBackup && !parsed.backupRestoreDir) parsed.backupRestoreDir = defaultBackupRestoreDir
  if (parsed.requireSqlite && !parsed.sqlite) parsed.sqlite = defaultSqlite

  return parsed
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(result.ok ? 'production-indexer: ready' : 'production-indexer: blocked')
  for (const check of result.checks) {
    console.log(`${check.ok ? 'ok' : 'fail'} ${check.id}: ${check.message}`)
  }
  console.log(result.nextStep)
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

function optionalNonNegativeInteger(value) {
  if (value === undefined || value === null || value === '') return null
  return Number.isFinite(Number(value)) ? Number(value) : null
}

function sourceFreshnessFromHealth(health, nowIso) {
  const now = new Date(nowIso)
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now()
  const candidates = [
    ['cursor.updatedAt', health.cursor?.updatedAt],
    ['checkpoint.updatedAt', health.checkpoint?.updatedAt],
  ]
  for (const [source, value] of candidates) {
    const timestamp = Date.parse(String(value ?? ''))
    if (Number.isFinite(timestamp)) {
      return {
        source,
        ageMinutes: Math.max(0, Math.floor((nowMs - timestamp) / 60_000)),
      }
    }
  }
  return { source: null, ageMinutes: null }
}

function usage() {
  return `Check durable production indexer state.

Usage:
  npm run check:indexer-production
  npm run check:indexer-production -- --rebuild --json

Options:
  --event-log <file>       Append-only event journal. Default: ${defaultEventLog}.
  --cursor <file>          Live collector cursor. Default: ${defaultCursor}.
  --checkpoint <file>      Persisted replay checkpoint. Default: ${defaultCheckpoint}.
  --sqlite <file>          SQLite/WAL database to verify before serving.
  --env-file <file>        Runtime env bound to the deployment. Default: ${defaultEnvFile}.
  --proof-report <file>    Passing devnet/prod proof report. Default: ${defaultProofReport}.
  --deployment-start-height <n>
                            Optional deployment start height used to reject pre-deployment events.
  --derive-deployment-start-height
                            Derive deployment start height from the earliest active core/treasury event in the journal.
  --archive-snapshot-height <n>
                            Optional archive snapshot height. Must be <= deployment start height when both are set. With --require-archive-snapshot, defaults to the height recorded in ${defaultArchiveSnapshot}.
  --archive-snapshot <file> Optional retained archive node snapshot artifact to prove the replay source is preserved. With --require-archive-snapshot, defaults to ${defaultArchiveSnapshot}.
  --require-archive-snapshot
                          Fail unless deployment start height, archive snapshot height, and snapshot artifact are configured.
  --backup-manifest <file> Optional indexer backup manifest to verify. With --require-backup, defaults to ${defaultBackupManifest}.
  --backup-restore-dir <dir>
                            Optional restore staging directory used while verifying the backup manifest. With --require-backup, defaults to ${defaultBackupRestoreDir}.
  --require-backup         Fail unless backup manifest and restore staging evidence are configured.
  --require-sqlite-backup  Fail unless the verified backup manifest includes the SQLite database.
  --require-sqlite         Fail unless SQLite/WAL serving state is configured and strict-health safe. Defaults --sqlite to ${defaultSqlite}.
  --max-lag-blocks <n>     Maximum accepted collector lag. Default: 12.
  --max-source-age-minutes <n>
                            Optional maximum age for cursor/checkpoint source timestamps.
  --rebuild                Rebuild checkpoint from the event journal before checking.
  --json                   Print machine-readable output.
  --help                   Show this message.`
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
