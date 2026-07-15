import { SUPPORTED_ENDPOINT_TYPES } from './constants.mjs'

export const LOCAL_INDEXER_ROUTES = new Set([
  '/health',
  '/commitment',
  '/search',
  '/names',
  '/resolve',
  '/name',
  '/records',
  '/record',
  '/record-history',
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
])

export const LOCAL_INDEXER_ROUTE_LIST = Object.freeze([...LOCAL_INDEXER_ROUTES])

export function routeParameters(pathname, url) {
  if (pathname === '/commitment') {
    return requiredCommitmentParameter(url)
  }
  if (
    pathname === '/name' ||
    pathname === '/records' ||
    pathname === '/record' ||
    pathname === '/record-history' ||
    pathname === '/activity' ||
    pathname === '/subname' ||
    pathname === '/marketplace/auction' ||
    pathname === '/marketplace/fixed-sale'
  ) {
    if (pathname === '/record') return requiredRecordParameters(url)
    if (pathname === '/record-history') return optionalRecordHistoryParameters(url)
    return requiredNodeParameter(url, 'node')
  }
  if (pathname === '/subnames') {
    return requiredNodeParameter(url, 'parentNode')
  }
  if (pathname === '/reverse') {
    return requiredEndpointParameters(url)
  }
  if (pathname === '/marketplace/offer') {
    const node = requiredNodeParameter(url, 'node')
    if (node.error) return node
    const authority = requiredAuthorityParameter(url, 'buyerAuthority')
    return authority.error ? authority : { ...node, ...authority }
  }
  if (pathname === '/marketplace/offers') {
    const node = optionalNodeParameter(url, 'node')
    if (node.error) return node
    const authority = optionalAuthorityParameter(url, 'buyerAuthority')
    return authority.error ? authority : { ...node, ...authority }
  }
  if (pathname === '/marketplace/refund') {
    return requiredAuthorityParameter(url, 'authority')
  }
  return {}
}

function requiredAuthorityParameter(url, parameter) {
  const value = url.searchParams.get(parameter)?.trim()
  if (!value) return { error: { error: 'missing_authority', parameter } }
  try {
    return { [parameter]: normalizeAuthority(value) }
  } catch {
    return { error: { error: 'invalid_authority', parameter } }
  }
}

function optionalAuthorityParameter(url, parameter) {
  const value = url.searchParams.get(parameter)?.trim()
  if (!value) return {}
  return requiredAuthorityParameter(url, parameter)
}

function normalizeAuthority(value) {
  const authority = normalizeNode(value)
  if (!/^0x[a-f0-9]{64}$/.test(authority)) throw new Error('invalid authority')
  return authority
}

export function sendJson(response, status, body, headers = {}, options = {}) {
  response.writeHead(status, {
    'access-control-allow-origin': corsOriginFromOptions(options),
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type, accept',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  if (status === 204) {
    response.end()
    return
  }
  response.end(JSON.stringify(body))
}

export function corsOriginFromOptions(options = {}) {
  const origin = String(options.corsOrigin ?? '').trim()
  return origin || '*'
}

export function normalizeName(value) {
  const trimmed = String(value ?? '').trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.endsWith('.dusk') ? trimmed : `${trimmed}.dusk`
}

export function normalizeNode(value) {
  if (!value) return ''
  const text = String(value).trim().toLowerCase()
  return text.startsWith('0x') ? text : `0x${text}`
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function requiredNodeParameter(url, parameter) {
  const raw = url.searchParams.get(parameter)
  if (!raw || !raw.trim()) {
    return {
      error: {
        error: 'missing_node',
        parameter,
        message: `${parameter} query parameter is required.`,
      },
    }
  }

  const node = normalizeNode(raw)
  if (!/^0x[a-f0-9]{64}$/.test(node)) {
    return {
      error: {
        error: 'invalid_node',
        parameter,
        message: `${parameter} must be a 32-byte hex node.`,
      },
    }
  }

  return parameter === 'parentNode' ? { parentNode: node } : { node }
}

function optionalNodeParameter(url, parameter) {
  const raw = url.searchParams.get(parameter)
  if (!raw?.trim()) return {}
  return requiredNodeParameter(url, parameter)
}

function requiredEndpointParameters(url) {
  const type = String(url.searchParams.get('type') ?? '').trim()
  const value = String(url.searchParams.get('value') ?? '').trim()

  if (!type || !value) {
    return {
      error: {
        error: 'missing_endpoint',
        message: 'type and value query parameters are required.',
      },
    }
  }

  if (!SUPPORTED_ENDPOINT_TYPES.has(type)) {
    return {
      error: {
        error: 'unsupported_endpoint_type',
        type,
        message: `${type} is not a supported reverse endpoint type.`,
      },
    }
  }

  return { endpoint: { type, value } }
}

function requiredCommitmentParameter(url) {
  const raw = url.searchParams.get('commitment')
  if (!raw || !raw.trim()) {
    return {
      error: {
        error: 'missing_commitment',
        parameter: 'commitment',
        message: 'commitment query parameter is required.',
      },
    }
  }

  const commitment = normalizeNode(raw)
  if (!/^0x[a-f0-9]{64}$/.test(commitment)) {
    return {
      error: {
        error: 'invalid_commitment',
        parameter: 'commitment',
        message: 'commitment must be a 32-byte hex value.',
      },
    }
  }

  return { commitment }
}

function requiredRecordParameters(url) {
  const nodeParams = requiredNodeParameter(url, 'node')
  if (nodeParams.error) return nodeParams
  const keyParams = recordKeyParameter(url, true)
  if (keyParams.error) return keyParams
  return { ...nodeParams, ...keyParams }
}

function optionalRecordHistoryParameters(url) {
  const nodeParams = requiredNodeParameter(url, 'node')
  if (nodeParams.error) return nodeParams
  const keyParams = recordKeyParameter(url, false)
  if (keyParams.error) return keyParams
  return { ...nodeParams, ...keyParams }
}

function recordKeyParameter(url, required) {
  const key = String(url.searchParams.get('key') ?? '').trim()
  if (!key) {
    return required
      ? {
          error: {
            error: 'missing_record_key',
            parameter: 'key',
            message: 'key query parameter is required.',
          },
        }
      : { key: null }
  }

  if (!/^[a-zA-Z0-9._:-]{1,96}$/.test(key)) {
    return {
      error: {
        error: 'invalid_record_key',
        parameter: 'key',
        message: 'key must be 1-96 visible characters using letters, numbers, dot, underscore, colon, or hyphen.',
      },
    }
  }

  return { key }
}
