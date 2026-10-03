import { isIP } from 'node:net'

export function securityOptionsFromEnv(env) {
  const production = env.NODE_ENV === 'production'
  return {
    production,
    corsOrigin: env.DUSK_DOMAINS_INDEXER_CORS_ORIGINS ?? env.DUSK_DOMAINS_INDEXER_CORS_ORIGIN ?? (production ? '' : '*'),
    rateLimit: envBoolean(env.DUSK_DOMAINS_INDEXER_RATE_LIMIT, production, 'DUSK_DOMAINS_INDEXER_RATE_LIMIT'),
    rateLimitMax: envInteger(env.DUSK_DOMAINS_INDEXER_RATE_LIMIT_MAX, 200, 'DUSK_DOMAINS_INDEXER_RATE_LIMIT_MAX'),
    rateLimitWindowMs: envInteger(env.DUSK_DOMAINS_INDEXER_RATE_LIMIT_WINDOW_MS, 60_000, 'DUSK_DOMAINS_INDEXER_RATE_LIMIT_WINDOW_MS'),
    trustedProxy: envBoolean(env.DUSK_DOMAINS_INDEXER_TRUST_PROXY, false, 'DUSK_DOMAINS_INDEXER_TRUST_PROXY'),
    allowPublicProxyTrust: envBoolean(env.DUSK_DOMAINS_INDEXER_ALLOW_PUBLIC_PROXY_TRUST, false, 'DUSK_DOMAINS_INDEXER_ALLOW_PUBLIC_PROXY_TRUST'),
  }
}

export function validateProxyListener(options) {
  const host = options.host
  const loopback = host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
  if (options.trustedProxy && !loopback && !options.allowPublicProxyTrust) {
    throw new Error('Trusted proxy requires a loopback listener; set DUSK_DOMAINS_INDEXER_ALLOW_PUBLIC_PROXY_TRUST=true only when network access is restricted to the proxy.')
  }
}

export function corsHeaders(options, request) {
  const origins = String(options.corsOrigin ?? (options.production ? '' : '*')).split(',').map((value) => value.trim()).filter(Boolean)
  const origin = request.headers.origin
  const allowed = origins.includes(origin) && origin !== '*' ? origin
    : !options.production && origins.includes('*') ? '*' : null
  return {
    vary: 'Origin',
    ...(allowed ? { 'access-control-allow-origin': allowed } : {}),
    'access-control-expose-headers': 'retry-after, x-request-id',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type, accept',
  }
}

export function createRateLimiter(options) {
  const enabled = options.rateLimit ?? options.production ?? false
  const max = options.rateLimitMax ?? 200
  const windowMs = options.rateLimitWindowMs ?? 60_000
  const now = options.now ?? Date.now
  const clients = new Map()
  return (request) => {
    if (!enabled) return 0
    const time = now()
    // Fixed windows are inserted in expiry order, so pruning is amortized per client.
    for (const [key, entry] of clients) {
      if (entry.resetAt > time) break
      clients.delete(key)
    }
    const ip = clientKey(request, options.trustedProxy)
    let entry = clients.get(ip)
    if (!entry || entry.resetAt <= time) {
      // Bound memory without evicting active clients and resetting their budgets.
      if (!entry && clients.size >= 100_000) return Math.max(1, Math.ceil((clients.values().next().value.resetAt - time) / 1000))
      entry = { count: 0, resetAt: time + windowMs }
      clients.set(ip, entry)
    }
    if (entry.count >= max) return Math.max(1, Math.ceil((entry.resetAt - time) / 1000))
    entry.count += 1
    return 0
  }
}

function clientKey(request, trustedProxy) {
  // The trusted proxy appends the address it saw; entries to its left come from the client.
  const forwarded = request.headers['x-forwarded-for']
  const candidate = typeof forwarded === 'string' ? forwarded.split(',').at(-1).trim() : ''
  const ip = trustedProxy && isIP(candidate) ? candidate : request.socket?.remoteAddress ?? 'unknown'
  if (isIP(ip) !== 6) return ip
  // URL canonicalization also converts embedded IPv4 tails into hex groups.
  const canonical = new URL(`http://[${ip.split('%')[0]}]`).hostname.slice(1, -1)
  const [left, right] = canonical.split('::').map((part) => part ? part.split(':') : [])
  const groups = (right ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left)
    .map((group) => parseInt(group, 16))
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.')
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`
}

function envBoolean(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`${name} must be true or false.`)
}

function envInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive integer.`)
  return Number(value)
}
