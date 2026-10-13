#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { isMain } from './is-main.mjs'
import { committedCandidateBytes, marketCandidatesFile } from './local-event-collector/candidates-file.mjs'
import {
  healthResponseForStore,
  loadSqliteStore,
} from '../server/local-indexer.mjs'

const defaultFiles = Object.freeze([
  { key: 'eventLog', path: 'target/dusk-domains-devnet-indexer.events.jsonl', required: true },
  { key: 'cursor', path: 'target/dusk-domains-devnet-indexer.cursor.json', required: true },
  { key: 'checkpoint', path: 'target/dusk-domains-devnet-indexer.checkpoint.json', required: true },
  { key: 'envFile', path: '.env.devnet.local', required: true },
  { key: 'deploymentProof', path: 'target/dusk-domains-devnet-proof.json', required: true },
  { key: 'browserWriteProof', path: 'target/browser-smoke-devnet-write/proof.json', required: false },
])

if (isMain(import.meta)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(usage())
    } else {
      const result = args.verify
        ? await verifyIndexerBackup(args)
        : await createIndexerBackup(args)
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export async function createIndexerBackup(options = {}) {
  const args = normalizeOptions(options)
  const backupId = args.backupId ?? timestampId(new Date())
  const outputDir = resolve(args.outputDir, backupId)
  const files = await backupFiles(args)
  const copied = []
  const missing = []

  await mkdir(outputDir, { recursive: true })

  for (const file of files) {
    const source = resolve(file.path)
    if (!existsSync(source)) {
      if (file.required) missing.push(file)
      continue
    }
    const destination = resolve(outputDir, `${file.key}-${basename(source)}`)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    const bytes = await readFile(destination)
    copied.push({
      key: file.key,
      source,
      destination,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      required: file.required,
    })
  }

  // The copies must restore together: journals cover what the copied cursor commits.
  const consistency = await cursorConsistency(Object.fromEntries(copied.map((file) => [file.key, file.destination])))
  const consistent = consistency.every((check) => check.ok)
  const manifest = {
    ok: missing.length === 0 && consistent,
    backupId,
    generatedAt: new Date().toISOString(),
    outputDir,
    copied,
    missing: missing.map((file) => ({ key: file.key, path: resolve(file.path), required: file.required })),
    consistency,
    nextStep: missing.length !== 0
      ? 'Backup is incomplete. Recreate it after the missing required files exist.'
      : !consistent
        ? 'Backup is inconsistent: a journal is shorter than its cursor commits. Stop the collector and API, or take a coherent filesystem snapshot, and recreate it.'
        : 'Checksummed backup manifest is complete. Store this directory with the archive-node snapshot for replay recovery.',
  }
  await writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function verifyIndexerBackup(options = {}) {
  const args = normalizeOptions(options)
  const manifestFile = resolve(args.manifest ?? manifestPathFromOptions(args))
  const checks = []
  const restored = []
  const push = (id, ok, message) => checks.push({ id, ok, message })

  let manifest = null
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    push('manifest_readable', true, `Backup manifest is readable: ${manifestFile}`)
  } catch (error) {
    push('manifest_readable', false, `Backup manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (manifest) {
    push('manifest_ok', manifest.ok === true, manifest.ok === true
      ? 'Backup manifest was complete when created.'
      : 'Backup manifest was incomplete when created.')
    const copied = Array.isArray(manifest.copied) ? manifest.copied : []
    push('copied_files', copied.length > 0, copied.length > 0
      ? `Backup manifest lists ${copied.length} copied file(s).`
      : 'Backup manifest does not list copied files.')
    // The collector refuses a cursor whose committed journals are missing or short.
    const paths = {}
    for (const file of copied) if (file?.key) paths[file.key] = await resolveBackupFile(manifestFile, file)
    for (const check of await cursorConsistency(paths)) push(check.id, check.ok, check.message)
    if (args.requireSqlite) {
      const hasSqlite = copied.some((file) => file?.key === 'sqliteDb')
      push('sqlite_backup_present', hasSqlite, hasSqlite
        ? 'Backup manifest includes the SQLite database.'
        : 'Public beta backup verification requires a SQLite database entry. Recreate the backup with --sqlite <db>.')
    }

    if (args.restoreDir) await mkdir(args.restoreDir, { recursive: true })

    for (const file of copied) {
      const key = String(file.key ?? 'file')
      const source = await resolveBackupFile(manifestFile, file)
      let bytes = null
      try {
        bytes = await readFile(source)
      } catch (error) {
        push(`file_${key}_readable`, false, `${key} backup file cannot be read: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      push(`file_${key}_checksum`, sha256 === file.sha256 && bytes.length === file.bytes, sha256 === file.sha256 && bytes.length === file.bytes
        ? `${key} checksum and size match.`
        : `${key} checksum or size mismatch.`)

      if (args.restoreDir) {
        const restorePath = resolve(args.restoreDir, `${key}-${basename(String(file.source ?? source))}`)
        await mkdir(dirname(restorePath), { recursive: true })
        await copyFile(source, restorePath)
        const restoredBytes = await readFile(restorePath)
        const restoredSha256 = createHash('sha256').update(restoredBytes).digest('hex')
        const ok = restoredSha256 === file.sha256 && restoredBytes.length === file.bytes
        push(`file_${key}_restore`, ok, ok
          ? `${key} restored to ${restorePath}.`
          : `${key} restore checksum or size mismatch.`)
        restored.push({
          key,
          path: restorePath,
          bytes: restoredBytes.length,
          sha256: restoredSha256,
          ok,
        })
        if (args.verifySqliteBoot && key === 'sqliteDb') {
          await verifyRestoredSqlite({
            checks,
            sqlitePath: restorePath,
            loadStore: args.loadSqliteStore ?? loadSqliteStore,
          })
        }
      }
    }
  }

  const ok = checks.every((check) => check.ok)
  return {
    ok,
    manifest: manifestFile,
    restoreDir: args.restoreDir ? resolve(args.restoreDir) : null,
    generatedAt: new Date().toISOString(),
    restored,
    checks,
    nextStep: ok
      ? args.restoreDir
        ? 'Backup verified and restore staging succeeded. Move staged files into the indexer data directory during recovery.'
        : 'Backup verified. Run again with --restore-dir to stage a recovery copy.'
      : 'Backup verification failed. Use a newer backup or rebuild from the archive-node snapshot.',
  }
}

export function parseArgs(argv) {
  const parsed = {
    help: false,
    outputDir: 'target/indexer-backups',
    verify: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--verify') parsed.verify = true
    else if (arg === '--output-dir') parsed.outputDir = requiredValue(argv, ++index, arg)
    else if (arg === '--backup-id') parsed.backupId = requiredValue(argv, ++index, arg)
    else if (arg === '--manifest') parsed.manifest = requiredValue(argv, ++index, arg)
    else if (arg === '--restore-dir') parsed.restoreDir = requiredValue(argv, ++index, arg)
    else if (arg === '--event-log') parsed.eventLog = requiredValue(argv, ++index, arg)
    else if (arg === '--cursor') parsed.cursor = requiredValue(argv, ++index, arg)
    else if (arg === '--checkpoint') parsed.checkpoint = requiredValue(argv, ++index, arg)
    else if (arg === '--env-file') parsed.envFile = requiredValue(argv, ++index, arg)
    else if (arg === '--deployment-proof') parsed.deploymentProof = requiredValue(argv, ++index, arg)
    else if (arg === '--browser-write-proof') parsed.browserWriteProof = requiredValue(argv, ++index, arg)
    else if (arg === '--sqlite') parsed.sqliteDb = requiredValue(argv, ++index, arg)
    else if (arg === '--market-candidates') parsed.marketCandidates = requiredValue(argv, ++index, arg)
    else if (arg === '--require-sqlite') parsed.requireSqlite = true
    else if (arg === '--verify-sqlite-boot') parsed.verifySqliteBoot = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return parsed
}

function normalizeOptions(options = {}) {
  return {
    outputDir: options.outputDir ?? 'target/indexer-backups',
    backupId: options.backupId ?? null,
    verify: Boolean(options.verify),
    manifest: options.manifest,
    restoreDir: options.restoreDir ? resolve(options.restoreDir) : null,
    eventLog: options.eventLog,
    cursor: options.cursor,
    checkpoint: options.checkpoint,
    envFile: options.envFile,
    deploymentProof: options.deploymentProof,
    browserWriteProof: options.browserWriteProof,
    sqliteDb: options.sqliteDb,
    marketCandidates: options.marketCandidates,
    requireSqlite: Boolean(options.requireSqlite),
    verifySqliteBoot: Boolean(options.verifySqliteBoot),
    loadSqliteStore: options.loadSqliteStore,
  }
}

async function backupFiles(args) {
  const files = defaultFiles.map((file) => ({
    ...file,
    path: args[file.key] ?? file.path,
  }))
  // The collector's market candidate journal beside its cursor, required once the cursor commits any.
  const cursor = files.find((file) => file.key === 'cursor').path
  files.push({
    key: 'marketCandidates',
    path: args.marketCandidates ?? marketCandidatesFile(cursor),
    required: (await committedCandidateBytes(cursor)) > 0,
  })
  // The cursor first, then the append-only journals: a running collector only lengthens them,
  // so copies taken after the cursor cover what it commits. The rest follow.
  const order = ['cursor', 'eventLog', 'marketCandidates']
  files.sort((a, b) => (order.indexOf(a.key) + 1 || order.length + 1) - (order.indexOf(b.key) + 1 || order.length + 1))
  if (args.sqliteDb) {
    files.push(
      { key: 'sqliteDb', path: args.sqliteDb, required: true },
      { key: 'sqliteWal', path: `${args.sqliteDb}-wal`, required: false },
      { key: 'sqliteShm', path: `${args.sqliteDb}-shm`, required: false },
    )
  }
  return files
}

/**
 * Whether the files at `paths` (by backup key) restore together: the event log holds the bytes,
 * and complete rows, the cursor commits, and the market candidate journal the bytes it commits.
 * A cursor that records neither, such as a legacy or non-collector cursor, has nothing to check.
 */
async function cursorConsistency(paths) {
  let cursor = null
  try { cursor = JSON.parse(await readFile(paths.cursor, 'utf8')) } catch { return [] }
  if (!cursor || typeof cursor !== 'object') return []
  const checks = []
  if (Number.isSafeInteger(cursor.eventLogBytes) && cursor.eventLogBytes >= 0) {
    const bytes = cursor.eventLogBytes
    const held = paths.eventLog ? (await stat(paths.eventLog).catch(() => null))?.size ?? 0 : 0
    let problem = held < bytes ? `holds ${held} of the ${bytes} bytes the cursor commits` : null
    if (!problem && bytes > 0) {
      const { rows, last } = await countRows(paths.eventLog, bytes)
      if (last !== 0x0a) problem = 'splits a row at the length the cursor commits'
      else if (Number.isSafeInteger(cursor.eventCount) && rows !== cursor.eventCount)
        problem = `holds ${rows} rows where the cursor commits ${cursor.eventCount}`
    } else if (!problem && Number.isSafeInteger(cursor.eventCount) && cursor.eventCount !== 0)
      problem = `holds no rows where the cursor commits ${cursor.eventCount}`
    checks.push({ id: 'event_log_covers_cursor', ok: !problem, message: problem
      ? `The event log ${problem}: it was copied before the cursor, or is damaged. Recreate the backup from a stopped collector or a coherent snapshot.`
      : `The event log holds the ${bytes} bytes the cursor commits.` })
  }
  const committed = Number.isSafeInteger(cursor.marketCandidatesBytes) && cursor.marketCandidatesBytes > 0 ? cursor.marketCandidatesBytes : 0
  if (committed > 0) {
    const held = paths.marketCandidates ? (await stat(paths.marketCandidates).catch(() => null))?.size ?? 0 : 0
    checks.push({ id: 'market_candidates_present', ok: held >= committed, message: held >= committed
      ? `Backup includes the ${committed} market candidate journal bytes the cursor commits.`
      : `The cursor commits ${committed} market candidate journal bytes the backup lacks (${held} held). Recreate it with --market-candidates <cursor>.market-candidates.jsonl.` })
  }
  return checks
}

/** Newline-terminated rows in the first `bytes` bytes of `file`, and the last byte read. */
async function countRows(file, bytes) {
  let rows = 0, last = null
  for await (const chunk of createReadStream(file, { start: 0, end: bytes - 1 })) {
    for (const byte of chunk) if (byte === 0x0a) rows++
    last = chunk[chunk.length - 1]
  }
  return { rows, last }
}

function manifestPathFromOptions(args) {
  if (!args.backupId) {
    throw new Error('Backup verification requires --manifest or --backup-id.')
  }
  return resolve(args.outputDir, args.backupId, 'manifest.json')
}

async function resolveBackupFile(manifestFile, file) {
  const candidates = [
    file.destination ? resolve(dirname(manifestFile), basename(String(file.destination))) : null,
    file.destination ? resolve(String(file.destination)) : null,
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return candidates[0] ?? resolve(dirname(manifestFile), String(file.key ?? 'file'))
}

async function verifyRestoredSqlite({ checks, sqlitePath, loadStore }) {
  const push = (id, ok, message) => checks.push({ id, ok, message })
  try {
    const store = await loadStore(sqlitePath, { strictHealth: false })
    const health = healthResponseForStore(store)
    push('sqlite_restore_boot', health.mode === 'sqlite', health.mode === 'sqlite'
      ? `Restored SQLite database boots with ${health.eventCount ?? 0} indexed event(s).`
      : `Restored SQLite database booted as unexpected mode ${health.mode ?? 'unknown'}.`)
    push('sqlite_restore_schema', store.sqlite?.schemaVersion === store.sqlite?.expectedSchemaVersion, store.sqlite?.schemaVersion === store.sqlite?.expectedSchemaVersion
      ? `Restored SQLite schema version ${store.sqlite?.schemaVersion} is current.`
      : `Restored SQLite schema version ${store.sqlite?.schemaVersion ?? 'unknown'} does not match expected ${store.sqlite?.expectedSchemaVersion ?? 'unknown'}.`)
  } catch (error) {
    push('sqlite_restore_boot', false, `Restored SQLite database did not boot: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function timestampId(date) {
  return date.toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, 'Z')
}

function requiredValue(argv, index, label) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`)
  return value
}

function usage() {
  return `Create a checksummed Dusk Domains indexer backup bundle.

Usage:
  npm run indexer:backup

Options:
  --output-dir <dir>              Backup root. Default: target/indexer-backups.
  --backup-id <id>                Stable backup directory name.
  --verify                        Verify an existing backup manifest instead of creating a backup.
  --manifest <file>               Manifest to verify. Alternative to --output-dir plus --backup-id.
  --restore-dir <dir>             Stage verified backup files into a recovery directory.
  --event-log <file>              Event journal file.
  --cursor <file>                 Collector cursor file.
  --checkpoint <file>             Replay checkpoint file.
  --env-file <file>               Runtime env file.
  --deployment-proof <file>       Deployment proof JSON.
  --browser-write-proof <file>    Optional installed-wallet browser proof JSON.
  --sqlite <file>                 Optional SQLite database; matching -wal and -shm sidecars are included when present.
  --market-candidates <file>      Collector market candidate journal. Default: <cursor>.market-candidates.jsonl;
                                  required once the cursor commits any of it.
  --require-sqlite                Verification fails unless the manifest includes the SQLite database.
  --verify-sqlite-boot            With --verify and --restore-dir, boot the restored SQLite DB and check schema.
  --help                          Show this message.`
}
