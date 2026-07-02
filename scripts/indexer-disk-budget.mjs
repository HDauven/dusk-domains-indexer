#!/usr/bin/env node

import { existsSync, statfsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const defaultLiveDir = '/var/lib/dusk-domains'
const defaultBackupDir = '/var/backups/dusk-domains'
const defaultWarnPercent = 70
const defaultIncidentPercent = 85

if (isCliEntry()) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(usage())
    } else {
      const result = await checkIndexerDiskBudget(args)
      if (args.out) await writeDiskBudgetArtifact(result, args.out)
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

export async function checkIndexerDiskBudget(options = {}) {
  const args = normalizeOptions(options)
  const exists = options.exists ?? existsSync
  const statfs = options.statfs ?? ((path) => statfsSync(path))
  const targets = [
    { id: 'live_state', label: 'Live indexer state', path: args.liveDir },
    { id: 'backup_state', label: 'Backup storage', path: args.backupDir },
  ]
  const checks = []
  const paths = []

  for (const target of targets) {
    const pathExists = exists(target.path)
    push(checks, `${target.id}_path`, pathExists, pathExists
      ? `${target.label} path exists: ${target.path}`
      : `${target.label} path is missing: ${target.path}`)

    let usage = null
    if (pathExists) {
      try {
        usage = diskUsageFromStatfs(statfs(target.path))
        push(checks, `${target.id}_statfs`, usage.valid, usage.valid
          ? `${target.label} filesystem usage is ${usage.usedPercent.toFixed(1)}%.`
          : `${target.label} filesystem stats are invalid.`)
        if (usage.valid) {
          push(checks, `${target.id}_warn_threshold`, usage.usedPercent < args.warnPercent,
            `${target.label} usage ${usage.usedPercent.toFixed(1)}% ${usage.usedPercent < args.warnPercent ? 'is below' : 'meets/exceeds'} warning threshold ${args.warnPercent}%.`)
          push(checks, `${target.id}_incident_threshold`, usage.usedPercent < args.incidentPercent,
            `${target.label} usage ${usage.usedPercent.toFixed(1)}% ${usage.usedPercent < args.incidentPercent ? 'is below' : 'meets/exceeds'} incident threshold ${args.incidentPercent}%.`)
        }
      } catch (error) {
        push(checks, `${target.id}_statfs`, false, `${target.label} filesystem stats failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    paths.push({
      ...target,
      exists: pathExists,
      usage,
    })
  }

  const ok = checks.every((check) => check.ok)
  return {
    ok,
    status: ok ? 'ready' : 'blocked',
    warnPercent: args.warnPercent,
    incidentPercent: args.incidentPercent,
    paths,
    checks,
    nextStep: ok
      ? 'Indexer disk budget is within beta thresholds.'
      : 'Free disk space, move verified backups off-host, or provision a larger persistent disk before public beta.',
  }
}

function diskUsageFromStatfs(stats) {
  const blockSize = Number(stats?.bsize ?? stats?.frsize ?? 0)
  const blocks = Number(stats?.blocks ?? 0)
  const availableBlocks = Number(stats?.bavail ?? stats?.bfree ?? 0)
  if (!Number.isFinite(blockSize) || !Number.isFinite(blocks) || !Number.isFinite(availableBlocks) || blockSize <= 0 || blocks <= 0 || availableBlocks < 0) {
    return {
      valid: false,
      totalBytes: 0,
      availableBytes: 0,
      usedBytes: 0,
      usedPercent: 100,
    }
  }
  const totalBytes = blocks * blockSize
  const availableBytes = Math.min(availableBlocks, blocks) * blockSize
  const usedBytes = totalBytes - availableBytes
  const usedPercent = (usedBytes / totalBytes) * 100
  return {
    valid: true,
    totalBytes,
    availableBytes,
    usedBytes,
    usedPercent,
  }
}

function push(checks, id, ok, message) {
  checks.push({ id, ok, message })
}

export function parseArgs(argv) {
  const parsed = {
    json: false,
    help: false,
    out: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') parsed.json = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--live-dir') parsed.liveDir = requiredValue(argv, ++index, arg)
    else if (arg === '--backup-dir') parsed.backupDir = requiredValue(argv, ++index, arg)
    else if (arg === '--warn-percent') parsed.warnPercent = parsePercent(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--incident-percent') parsed.incidentPercent = parsePercent(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--out') parsed.out = requiredValue(argv, ++index, arg)
    else throw new Error(`Unknown option: ${arg}`)
  }
  return parsed
}

function normalizeOptions(options = {}) {
  const warnPercent = Number.isFinite(Number(options.warnPercent)) ? Number(options.warnPercent) : defaultWarnPercent
  const incidentPercent = Number.isFinite(Number(options.incidentPercent)) ? Number(options.incidentPercent) : defaultIncidentPercent
  if (warnPercent <= 0 || warnPercent >= 100) throw new Error('--warn-percent must be greater than 0 and less than 100')
  if (incidentPercent <= 0 || incidentPercent > 100) throw new Error('--incident-percent must be greater than 0 and at most 100')
  if (warnPercent >= incidentPercent) throw new Error('--warn-percent must be lower than --incident-percent')
  return {
    liveDir: resolve(options.liveDir ?? defaultLiveDir),
    backupDir: resolve(options.backupDir ?? defaultBackupDir),
    warnPercent,
    incidentPercent,
    json: Boolean(options.json),
    out: options.out ?? '',
  }
}

export async function writeDiskBudgetArtifact(result, outFile) {
  const target = resolve(outFile)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return target
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(result.ok ? 'indexer-disk-budget: ready' : 'indexer-disk-budget: blocked')
  for (const path of result.paths) {
    if (!path.usage?.valid) {
      console.log(`${path.label}: unavailable (${path.path})`)
      continue
    }
    console.log(`${path.label}: ${path.usage.usedPercent.toFixed(1)}% used, ${formatBytes(path.usage.availableBytes)} available of ${formatBytes(path.usage.totalBytes)} (${path.path})`)
  }
  for (const check of result.checks) {
    console.log(`${check.ok ? 'ok' : 'fail'} ${check.id}: ${check.message}`)
  }
  console.log(result.nextStep)
}

function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function parsePercent(value, label) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`)
  return parsed
}

function requiredValue(argv, index, label) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`)
  return value
}

function usage() {
  return `Check hosted indexer disk budget for live SQLite/WAL state and backup storage.

Usage:
  npm run indexer:disk
  npm run indexer:disk -- --live-dir /var/lib/dusk-domains --backup-dir /var/backups/dusk-domains --json

Options:
  --live-dir <path>          Live indexer state path. Default: ${defaultLiveDir}
  --backup-dir <path>        Backup bundle path. Default: ${defaultBackupDir}
  --warn-percent <n>         Fail when usage is >= this threshold. Default: ${defaultWarnPercent}
  --incident-percent <n>     Incident threshold shown in output. Default: ${defaultIncidentPercent}
  --out <file>               Write JSON evidence to a file.
  --json                     Print machine-readable output.
  --help                     Show this message.`
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
