import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import {
  eventContractKeys,
  legacyContractKeys,
  normalizeContractId,
} from './deployment-surface.mjs'

export async function auditEventJournalDeploymentBinding({
  eventLog,
  deployment,
  deploymentStartHeight,
  deriveDeploymentStartHeight,
  archiveSnapshotHeight,
  archiveSnapshot,
  requireArchiveSnapshot,
  exists = existsSync,
}) {
  const entries = parseJournalEntries(await readFile(eventLog, 'utf8'))
  const checks = []
  const push = (id, ok, message) => checks.push({ id, ok, message })
  const bindings = new Map()
  const legacyRows = []
  const unknownRows = []
  const belowStart = []
  const activeBlockHeights = []
  // Contract pools (ADR 0002): registries the router adds all emit as core.
  const poolRegistries = new Set(entries
    .filter((entry) => entry?.meta?.contractKey === 'router' && entry.event?.type === 'pool_member_added' && entry.event.kind === 'registry')
    .map((entry) => normalizeContractId(entry.event.member)))

  for (const [index, entry] of entries.entries()) {
    const meta = entry?.meta ?? {}
    const key = String(meta.contractKey ?? '').toLowerCase()
    const id = normalizeContractId(meta.contractId)
    if (!key) continue
    if (legacyContractKeys.includes(key)) legacyRows.push(index + 1)
    else if (!eventContractKeys.includes(key)) unknownRows.push(`${index + 1}:${key}`)
    if (eventContractKeys.includes(key) && id) {
      if (!bindings.has(key)) bindings.set(key, new Set())
      bindings.get(key).add(id)
    }
    const height = numberOrNull(meta.blockHeight)
    if (eventContractKeys.includes(key) && height !== null) activeBlockHeights.push(height)
  }

  const derivedDeploymentStartHeight = activeBlockHeights.length
    ? Math.min(...activeBlockHeights)
    : null
  const usesDerivedDeploymentStartHeight = deploymentStartHeight === null && deriveDeploymentStartHeight
  const resolvedDeploymentStartHeight = deploymentStartHeight ?? (usesDerivedDeploymentStartHeight ? derivedDeploymentStartHeight : null)

  if (usesDerivedDeploymentStartHeight) {
    push('deployment_start_height_derived', resolvedDeploymentStartHeight !== null, resolvedDeploymentStartHeight !== null
      ? `Deployment start height ${resolvedDeploymentStartHeight} was derived from the earliest active contract event.`
      : 'Could not derive deployment start height because the event journal has no active contract block metadata.')
  }

  for (const [index, entry] of entries.entries()) {
    const meta = entry?.meta ?? {}
    const height = numberOrNull(meta.blockHeight)
    if (deploymentStartHeight !== null && height !== null && height < deploymentStartHeight) {
      belowStart.push(`${index + 1}:${height}`)
    }
    if (deploymentStartHeight === null && resolvedDeploymentStartHeight !== null && height !== null && height < resolvedDeploymentStartHeight) {
      belowStart.push(`${index + 1}:${height}`)
    }
  }

  push('event_journal_contract_keys', legacyRows.length === 0 && unknownRows.length === 0, legacyRows.length === 0 && unknownRows.length === 0
    ? 'Event journal contains only active production contract keys.'
    : `Event journal has legacy or unknown contract keys: ${[...legacyRows.map((row) => `legacy row ${row}`), ...unknownRows].join(', ')}.`)

  for (const key of eventContractKeys) {
    const observed = [...(bindings.get(key) ?? [])]
    const pooled = key === 'core' && observed.length > 1 && observed.every((value) => poolRegistries.has(value))
    push(`event_journal_${key}_contract`, observed.length === 1 || pooled, observed.length === 1 || pooled
      ? `Event journal binds ${key} to ${observed.join(', ')}.`
      : `Event journal should bind ${key} to exactly one contract ID, or to registries the router added; observed ${observed.length ? observed.join(', ') : 'none'}.`)
    if (deployment?.ok && observed.length > 0) {
      const expected = deployment.contracts[key]
      // The deployment names the first registry; later ones joined through the router.
      const mismatched = pooled
        ? (observed.includes(expected) ? [] : observed)
        : observed.filter((value) => value !== expected)
      push(`event_journal_${key}_matches_deployment`, mismatched.length === 0, mismatched.length === 0
        ? `Event journal ${key} contract matches deployment evidence.`
        : `Event journal ${key} contract mismatch; expected ${expected}, observed ${observed.join(', ')}.`)
    }
  }

  if (requireArchiveSnapshot) {
    push('archive_snapshot_required_deployment_start_height', resolvedDeploymentStartHeight !== null, resolvedDeploymentStartHeight !== null
      ? `Deployment start height ${resolvedDeploymentStartHeight} is configured for archive retention.`
      : 'Public beta archive retention requires --deployment-start-height or --derive-deployment-start-height.')
    push('archive_snapshot_required_height', archiveSnapshotHeight !== null, archiveSnapshotHeight !== null
      ? `Archive snapshot height ${archiveSnapshotHeight} is configured.`
      : 'Public beta archive retention requires --archive-snapshot-height.')
    push('archive_snapshot_required_file', Boolean(archiveSnapshot), Boolean(archiveSnapshot)
      ? `Archive snapshot artifact is configured: ${archiveSnapshot}.`
      : 'Public beta archive retention requires --archive-snapshot.')
  }

  if (resolvedDeploymentStartHeight !== null) {
    push('archive_snapshot_height_configured', archiveSnapshotHeight !== null, archiveSnapshotHeight !== null
      ? `Archive snapshot height ${archiveSnapshotHeight} is configured.`
      : 'Deployment start height is configured, but archive snapshot height is missing.')
    push('deployment_start_height', belowStart.length === 0, belowStart.length === 0
      ? `No event with block metadata predates deployment start height ${resolvedDeploymentStartHeight}.`
      : `Event rows predate deployment start height ${resolvedDeploymentStartHeight}: ${belowStart.join(', ')}.`)
  }
  if (archiveSnapshotHeight !== null && resolvedDeploymentStartHeight !== null) {
    push('archive_snapshot_height', archiveSnapshotHeight <= resolvedDeploymentStartHeight, archiveSnapshotHeight <= resolvedDeploymentStartHeight
      ? `Archive snapshot height ${archiveSnapshotHeight} covers deployment start height ${resolvedDeploymentStartHeight}.`
      : `Archive snapshot height ${archiveSnapshotHeight} is after deployment start height ${resolvedDeploymentStartHeight}.`)
  }
  if (archiveSnapshot) {
    push('archive_snapshot_file', exists(archiveSnapshot), exists(archiveSnapshot)
      ? `Archive snapshot file exists: ${archiveSnapshot}`
      : `Archive snapshot file is missing: ${archiveSnapshot}`)
  }

  return {
    checks,
    deploymentStartHeight: resolvedDeploymentStartHeight,
    derivedDeploymentStartHeight,
  }
}

export function parseJournalEntries(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : []
  }
  return trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
