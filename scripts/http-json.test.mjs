import { describe, expect, it } from 'vitest'
import {
  fetchJson,
  normalizeHttpBaseUrl,
  probeFetch,
  urlJoin,
} from './http-json.mjs'

describe('script JSON HTTP helpers', () => {
  it('joins endpoint paths against normalized base URLs', () => {
    expect(urlJoin('http://127.0.0.1:8787', '/health')).toBe('http://127.0.0.1:8787/health')
    expect(urlJoin('http://127.0.0.1:8787/', 'records?node=abc')).toBe('http://127.0.0.1:8787/records?node=abc')
  })

  it('normalizes http base URLs and rejects unsupported schemes', () => {
    expect(normalizeHttpBaseUrl(' http://127.0.0.1:8787/// ', 'Indexer base URL')).toBe('http://127.0.0.1:8787')
    expect(() => normalizeHttpBaseUrl('ftp://127.0.0.1:8787', 'Indexer base URL'))
      .toThrow('Indexer base URL must be http(s).')
  })

  it('returns parsed JSON for successful responses', async () => {
    await expect(fetchJson(async () => Response.json({ ok: true }), 'http://127.0.0.1:8787/health'))
      .resolves
      .toMatchObject({
        ok: true,
        status: 200,
        body: { ok: true },
      })
  })

  it('preserves concise JSON and text error details', async () => {
    await expect(fetchJson(async () => Response.json({ message: 'Indexer health failed.' }, { status: 503 }), 'http://127.0.0.1:8787/health'))
      .resolves
      .toMatchObject({
        ok: false,
        status: 503,
        error: 'HTTP 503: Indexer health failed.',
      })

    await expect(fetchJson(async () => new Response('plain text failure', { status: 500 }), 'http://127.0.0.1:8787/health'))
      .resolves
      .toMatchObject({
        ok: false,
        status: 500,
        error: 'HTTP 500: plain text failure',
      })
  })

  it('turns fetch throws into unreachable probe and JSON results', async () => {
    const fetcher = async () => {
      throw new Error('connection refused')
    }

    await expect(probeFetch(fetcher, 'http://127.0.0.1:8787/health')).resolves.toEqual({
      reachable: false,
      error: 'connection refused',
    })
    await expect(fetchJson(fetcher, 'http://127.0.0.1:8787/health')).resolves.toEqual({
      ok: false,
      error: 'connection refused',
    })
  })
})
