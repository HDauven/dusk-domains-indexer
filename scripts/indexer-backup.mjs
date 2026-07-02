#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const defaultFiles = Object.freeze([
  { key: 'eventLog', path: 'target/dusk-names-devnet-indexer.events.jsonl', required: true },
  { key: 'cursor', path: 'target/dusk-names-devnet-indexer.cursor.json', required: true },
  { key: 'checkpoint', path: 'target/dusk-names-devnet-indexer.checkpoint.json', required: true },
  { key: 'envFile', path: '.env.devnet.local', required: true },
  { key: 'deploymentProof', path: 'target/dusk-names-devnet-proof.json', required: true },
  { key: 'browserWriteProof', path: 'target/browser-smoke-devnet-write/proof.json', required: false },
])

if (isCliEntry()) {
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
  const files = backupFiles(args)
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

  const manifest = {
    ok: missing.length === 0,
    backupId,
    generatedAt: new Date().toISOString(),
    outputDir,
    copied,
    missing: missing.map((file) => ({ key: file.key, path: resolve(file.path), required: file.required })),
    nextStep: missing.length === 0
      ? 'Checksummed backup manifest is complete. Store this directory with the archive-node snapshot for replay recovery.'
      : 'Backup is incomplete. Recreate it after the missing required files exist.',
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
    else if (arg === '--require-sqlite') parsed.requireSqlite = true
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
    requireSqlite: Boolean(options.requireSqlite),
  }
}

function backupFiles(args) {
  const files = defaultFiles.map((file) => ({
    ...file,
    path: args[file.key] ?? file.path,
  }))
  if (args.sqliteDb) {
    files.push(
      { key: 'sqliteDb', path: args.sqliteDb, required: true },
      { key: 'sqliteWal', path: `${args.sqliteDb}-wal`, required: false },
      { key: 'sqliteShm', path: `${args.sqliteDb}-shm`, required: false },
    )
  }
  return files
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
  --require-sqlite                Verification fails unless the manifest includes the SQLite database.
  --help                          Show this message.`
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
