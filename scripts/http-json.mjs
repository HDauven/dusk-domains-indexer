export async function probeFetch(fetcher, url) {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(2_500) })
    return { reachable: true, status: response.status }
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function fetchJson(fetcher, url) {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(2_500) })
    const { body, error } = await readResponseBody(response)
    return {
      ok: response.ok,
      status: response.status,
      body,
      ...(response.ok ? {} : { error: responseErrorMessage(response.status, error) }),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function urlJoin(base, path) {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString()
}

export function normalizeHttpBaseUrl(value, label = 'Base URL') {
  const text = String(value ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(text)) throw new Error(`${label} must be http(s).`)
  return text
}

function responseErrorMessage(status, detail) {
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`
}

async function readResponseBody(response) {
  const text = await response.text().catch(() => '')
  if (!text.trim()) return { body: null, error: '' }

  try {
    const body = JSON.parse(text)
    return { body, error: errorDetailFromPayload(body) }
  } catch {
    return { body: null, error: truncateErrorDetail(text) }
  }
}

function errorDetailFromPayload(payload) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string') return truncateErrorDetail(payload.message)
    if (typeof payload.error === 'string') return truncateErrorDetail(payload.error)
    if (typeof payload.code === 'string') return truncateErrorDetail(payload.code)
  }

  return ''
}

function truncateErrorDetail(value) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!normalized) return ''
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized
}
