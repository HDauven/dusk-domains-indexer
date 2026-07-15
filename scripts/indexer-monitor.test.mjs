import { describe, expect, it } from 'vitest'
import {
  monitorIndexerHealth,
  parseArgs,
} from './indexer-monitor.mjs'

describe('indexer monitor', () => {
  it('parses monitor CLI options', () => {
    expect(parseArgs([
      '--health-url',
      'https://indexer.example/health',
      '--alert-webhook-url',
      'https://alerts.example/dusk-domains',
      '--require-alert-webhook',
      '--max-lag-blocks',
      '8',
      '--max-source-age-minutes',
      '15',
      '--min-events',
      '10',
      '--deployment-start-height',
      '100',
      '--archive-snapshot-height',
      '99',
      '--archive-snapshot',
      '/var/snapshots/dusk-before-launch',
      '--interval-ms',
      '5000',
      '--iterations',
      '2',
      '--json',
    ])).toEqual({
      help: false,
      json: true,
      healthUrl: 'https://indexer.example/health',
      alertWebhookUrl: 'https://alerts.example/dusk-domains',
      requireAlertWebhook: true,
      maxLagBlocks: 8,
      maxSourceAgeMinutes: 15,
      minEvents: 10,
      deploymentStartHeight: 100,
      archiveSnapshotHeight: 99,
      archiveSnapshot: '/var/snapshots/dusk-before-launch',
      intervalMs: 5000,
      iterations: 2,
    })
  })

  it('passes healthy health without sending an alert', async () => {
    const calls = []
    const result = await monitorIndexerHealth({
      healthUrl: 'http://indexer/health',
      fetch: async (url) => {
        calls.push(url)
        return Response.json(healthyPayload())
      },
    })

    expect(result.ok).toBe(true)
    expect(calls).toEqual(['http://indexer/health'])
    expect(result.results[0].alert).toMatchObject({
      ok: true,
      attempted: false,
      reason: 'health_ok',
    })
  })

  it('fails closed on unsafe health when alert webhook is required but missing', async () => {
    const result = await monitorIndexerHealth({
      healthUrl: 'http://indexer/health',
      requireAlertWebhook: true,
      fetch: async () => Response.json({
        ...healthyPayload(),
        ok: false,
        durability: { message: 'collector cursor is stale' },
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.results[0].probe.checks.find((check) => check.id === 'health_ok')).toMatchObject({
      ok: false,
      message: expect.stringContaining('collector cursor is stale'),
    })
    expect(result.results[0].alert).toMatchObject({
      ok: false,
      attempted: false,
      reason: 'missing_alert_webhook',
    })
  })

  it('sends a webhook alert for unsafe health', async () => {
    const calls = []
    const result = await monitorIndexerHealth({
      healthUrl: 'http://indexer/health',
      alertWebhookUrl: 'https://alerts.example/dusk-domains',
      requireAlertWebhook: true,
      fetch: async (url, init) => {
        calls.push({ url, init })
        if (url === 'http://indexer/health') {
          return Response.json({
            ...healthyPayload(),
            ok: false,
            lagBlocks: 99,
          })
        }
        return Response.json({ ok: true })
      },
    })

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({
      url: 'https://alerts.example/dusk-domains',
      init: {
        method: 'POST',
      },
    })
    const body = JSON.parse(calls[1].init.body)
    expect(body).toMatchObject({
      service: 'dusk-domains-indexer',
      severity: 'critical',
      healthUrl: 'http://indexer/health',
    })
    expect(body.failedChecks.map((check) => check.id)).toContain('health_ok')
    expect(body.failedChecks.map((check) => check.id)).toContain('lag')
    expect(result.results[0].alert).toMatchObject({
      ok: true,
      attempted: true,
      reason: 'alert_sent',
    })
  })

  it('fails when unsafe health alert delivery fails', async () => {
    const result = await monitorIndexerHealth({
      healthUrl: 'http://indexer/health',
      alertWebhookUrl: 'https://alerts.example/dusk-domains',
      requireAlertWebhook: true,
      fetch: async (url) => {
        if (url === 'http://indexer/health') {
          return Response.json({
            ...healthyPayload(),
            ok: false,
          })
        }
        return Response.json({ ok: false }, { status: 503 })
      },
    })

    expect(result.ok).toBe(false)
    expect(result.results[0].alert).toMatchObject({
      ok: false,
      attempted: true,
      status: 503,
      reason: 'alert_webhook_failed',
    })
  })

  it('runs multiple iterations with injected sleep', async () => {
    const slept = []
    const result = await monitorIndexerHealth({
      healthUrl: 'http://indexer/health',
      intervalMs: 25,
      iterations: 2,
      fetch: async () => Response.json(healthyPayload()),
      sleep: async (ms) => slept.push(ms),
    })

    expect(result.ok).toBe(true)
    expect(result.iterations).toBe(2)
    expect(slept).toEqual([25])
  })
})

function healthyPayload() {
  return {
    ok: true,
    schemaVersion: 1,
    eventCount: 12,
    currentBlockHeight: 130,
    lagBlocks: 0,
    cursor: {
      updatedAt: '2026-06-22T00:00:00.000Z',
    },
    routes: [
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
    ],
    lastEvent: {
      eventName: 'name_registered',
      blockHeight: 123,
    },
  }
}
