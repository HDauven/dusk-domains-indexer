#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { probeIndexerHealth } from './indexer-health-probe.mjs'

const defaultHealthUrl = process.env.DUSK_DOMAINS_INDEXER_HEALTH_URL
  ?? process.env.DUSK_NAMES_INDEXER_HEALTH_URL
  ?? 'http://127.0.0.1:8787/health'
const defaultAlertWebhookUrl = process.env.DUSK_DOMAINS_INDEXER_ALERT_WEBHOOK_URL
  ?? process.env.DUSK_NAMES_INDEXER_ALERT_WEBHOOK_URL
  ?? ''

if (isCliEntry()) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(usage())
    } else {
      const result = await monitorIndexerHealth(args)
      console.log(args.json ? JSON.stringify(result, null, 2) : formatResult(result))
      if (!result.ok) process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export async function monitorIndexerHealth(options = {}) {
  const args = normalizeOptions(options)
  const fetcher = options.fetch ?? globalThis.fetch
  if (!fetcher) throw new Error('Indexer monitor requires fetch.')
  const sleep = options.sleep ?? sleepMs
  const iterations = []

  for (let index = 0; index < args.iterations; index += 1) {
    const probe = await probeIndexerHealth({
      healthUrl: args.healthUrl,
      maxLagBlocks: args.maxLagBlocks,
      maxSourceAgeMinutes: args.maxSourceAgeMinutes,
      minEvents: args.minEvents,
      deploymentStartHeight: args.deploymentStartHeight,
      archiveSnapshotHeight: args.archiveSnapshotHeight,
      archiveSnapshot: args.archiveSnapshot,
      fetch: fetcher,
    })
    const alert = await maybeSendAlert({ args, probe, fetcher, iteration: index + 1 })
    iterations.push({ index: index + 1, probe, alert })
    if (index < args.iterations - 1) await sleep(args.intervalMs)
  }

  const ok = iterations.every((iteration) => iteration.probe.ok && iteration.alert.ok)
  return {
    ok,
    healthUrl: args.healthUrl,
    alertWebhookConfigured: Boolean(args.alertWebhookUrl),
    requireAlertWebhook: args.requireAlertWebhook,
    iterations: iterations.length,
    intervalMs: args.intervalMs,
    generatedAt: new Date().toISOString(),
    results: iterations,
    nextStep: ok
      ? 'Indexer monitor passed.'
      : 'Treat the indexer as unsafe for write-confirmation paths and investigate health, collector, checkpoint, or alert delivery.',
  }
}

export function parseArgs(argv) {
  const parsed = {
    help: false,
    json: false,
    healthUrl: defaultHealthUrl,
    alertWebhookUrl: defaultAlertWebhookUrl,
    requireAlertWebhook: false,
    maxLagBlocks: 12,
    maxSourceAgeMinutes: null,
    minEvents: 1,
    deploymentStartHeight: null,
    archiveSnapshotHeight: null,
    archiveSnapshot: '',
    intervalMs: 60_000,
    iterations: 1,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--json') parsed.json = true
    else if (arg === '--require-alert-webhook') parsed.requireAlertWebhook = true
    else if (arg === '--health-url') parsed.healthUrl = requiredValue(argv, ++index, arg)
    else if (arg === '--alert-webhook-url') parsed.alertWebhookUrl = requiredValue(argv, ++index, arg)
    else if (arg === '--max-lag-blocks') parsed.maxLagBlocks = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--max-source-age-minutes') parsed.maxSourceAgeMinutes = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--min-events') parsed.minEvents = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--deployment-start-height') parsed.deploymentStartHeight = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--archive-snapshot-height') parsed.archiveSnapshotHeight = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--archive-snapshot') parsed.archiveSnapshot = requiredValue(argv, ++index, arg)
    else if (arg === '--interval-ms') parsed.intervalMs = parsePositiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--iterations') parsed.iterations = parsePositiveInteger(requiredValue(argv, ++index, arg), arg)
    else throw new Error(`Unknown option: ${arg}`)
  }
  return parsed
}

function normalizeOptions(options = {}) {
  return {
    healthUrl: String(options.healthUrl ?? defaultHealthUrl),
    alertWebhookUrl: String(options.alertWebhookUrl ?? defaultAlertWebhookUrl).trim(),
    requireAlertWebhook: Boolean(options.requireAlertWebhook),
    maxLagBlocks: Number.isFinite(Number(options.maxLagBlocks)) ? Number(options.maxLagBlocks) : 12,
    maxSourceAgeMinutes: optionalNonNegativeInteger(options.maxSourceAgeMinutes),
    minEvents: Number.isFinite(Number(options.minEvents)) ? Number(options.minEvents) : 1,
    deploymentStartHeight: optionalNonNegativeInteger(options.deploymentStartHeight),
    archiveSnapshotHeight: optionalNonNegativeInteger(options.archiveSnapshotHeight),
    archiveSnapshot: String(options.archiveSnapshot ?? '').trim(),
    intervalMs: Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
      ? Number(options.intervalMs)
      : 60_000,
    iterations: Number.isFinite(Number(options.iterations)) && Number(options.iterations) > 0
      ? Number(options.iterations)
      : 1,
  }
}

async function maybeSendAlert({ args, probe, fetcher, iteration }) {
  if (probe.ok) {
    return { ok: true, attempted: false, reason: 'health_ok' }
  }
  if (!args.alertWebhookUrl) {
    return {
      ok: !args.requireAlertWebhook,
      attempted: false,
      reason: args.requireAlertWebhook ? 'missing_alert_webhook' : 'alert_webhook_not_configured',
    }
  }

  const failedChecks = probe.checks.filter((check) => !check.ok)
  try {
    const response = await fetcher(args.alertWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'dusk-domains-indexer',
        severity: 'critical',
        iteration,
        healthUrl: args.healthUrl,
        generatedAt: new Date().toISOString(),
        failedChecks,
        nextStep: probe.nextStep,
      }),
    })
    return {
      ok: response.ok,
      attempted: true,
      status: response.status,
      reason: response.ok ? 'alert_sent' : 'alert_webhook_failed',
    }
  } catch (error) {
    return {
      ok: false,
      attempted: true,
      reason: 'alert_webhook_error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function formatResult(result) {
  const failed = result.results.filter((entry) => !entry.probe.ok || !entry.alert.ok)
  return [
    `indexer monitor: ${result.ok ? 'ready' : 'unsafe'}`,
    `iterations: ${result.iterations}`,
    `alert webhook: ${result.alertWebhookConfigured ? 'configured' : 'not configured'}`,
    ...failed.flatMap((entry) => [
      `- iteration ${entry.index}: ${entry.probe.ok ? 'health ok' : 'health failed'}; alert ${entry.alert.reason}`,
      ...entry.probe.checks.filter((check) => !check.ok).map((check) => `  - ${check.id}: ${check.message}`),
    ]),
    `next: ${result.nextStep}`,
  ].join('\n')
}

function requiredValue(argv, index, label) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`)
  return value
}

function parseNonNegativeInteger(value, label) {
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}

function parsePositiveInteger(value, label) {
  const number = parseNonNegativeInteger(value, label)
  if (number <= 0) throw new Error(`${label} must be greater than zero`)
  return number
}

function optionalNonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function usage() {
  return `Monitor a Dusk Domains indexer health endpoint and optionally send webhook alerts.

Usage:
  npm run indexer:monitor
  npm run indexer:monitor -- --require-alert-webhook --alert-webhook-url https://alerts.example/dusk-domains

Options:
  --health-url <url>          Health endpoint. Default: ${defaultHealthUrl}.
  --alert-webhook-url <url>   Alert webhook. Defaults to DUSK_DOMAINS_INDEXER_ALERT_WEBHOOK_URL.
  --require-alert-webhook     Fail unsafe health if no alert webhook is configured.
  --max-lag-blocks <n>        Maximum accepted indexer lag. Default: 12.
  --max-source-age-minutes <n>
                              Optional maximum age for cursor/checkpoint source timestamps.
  --min-events <n>            Minimum indexed events required. Default: 1.
  --deployment-start-height <n>
                              Optional deployment start height for launch-readiness validation.
  --archive-snapshot-height <n>
                              Optional archive snapshot height. Must be <= deployment start height.
  --archive-snapshot <path>   Optional retained archive-node snapshot artifact path to verify locally.
  --interval-ms <n>           Delay between monitor iterations. Default: 60000.
  --iterations <n>            Number of monitor iterations. Default: 1.
  --json                      Print machine-readable output.
  --help                      Show this message.`
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
