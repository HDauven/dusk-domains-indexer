import { isIP } from 'node:net'
import { lifecycleClock, lifecycleMomentPassed, subnameLifecycleForNode } from './read-models/lifecycle.mjs'

const RESOLVERS = ['https://1.1.1.1/dns-query', 'https://dns.google/resolve']
const MAX_AGE_MS = 6 * 60 * 60 * 1000
const RETRY_MINUTES = [5, 15, 30, 60]
const MIN_RECHECK_MS = 5 * 60 * 1000
const PREFIX = 'dusk-domains-verification='

export function websiteDomain(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value)) return null
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]
  if (!authority || !/^[a-z0-9.-]+$/i.test(authority)) return null
  try {
    const url = new URL(value)
    const host = url.hostname
    if (isIP(host) || host !== authority.toLowerCase() || `_dusk-domains.${host}`.length > 253) return null
    const labels = host.split('.')
    if (labels.length < 2 || !/[a-z]/i.test(labels.at(-1))) return null
    return labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ? host : null
  } catch { return null }
}

// DNS JSON uses presentation-format TXT: one or more quoted character strings.
export function parseTxt(value) {
  if (typeof value !== 'string' || value.length > 8192) return null
  let result = '', offset = 0, chunks = 0
  while (offset < value.length) {
    while (value[offset] === ' ' || value[offset] === '\t') offset++
    if (offset === value.length) break
    if (value[offset++] !== '"') return null
    chunks++
    let closed = false
    while (offset < value.length) {
      let char = value[offset++]
      if (char === '"') { closed = true; break }
      if (char === '\\') {
        if (offset >= value.length) return null
        const decimal = value.slice(offset, offset + 3)
        if (/^\d{3}$/.test(decimal)) {
          if (Number(decimal) > 255) return null
          char = String.fromCharCode(Number(decimal)); offset += 3
        } else char = value[offset++]
      }
      result += char
    }
    if (!closed || (offset < value.length && !/[ \t]/.test(value[offset]))) return null
  }
  return chunks ? result : null
}

function binding(store, node) {
  if (store.unavailable) return null
  const name = store.namesByNode.get(node) ?? subnameLifecycleForNode(store, node)
  if (!name?.owner || name.status !== 'active' || !name.resolverId
    || lifecycleMomentPassed(name.expiresAtBlockHeight, name.expiresAt, lifecycleClock(store))) return null
  const indexed = store.namesByCanonical.get(name.canonicalName)
  if ((name.resolverHealth && name.resolverHealth !== 'ok') || (indexed?.resolverHealth && indexed.resolverHealth !== 'ok')) return null
  const websites = (store.recordsByNode.get(node) ?? []).filter(record => record.key === 'website')
  if (websites.length !== 1) return null
  const website = websites[0]
  const domain = websiteDomain(website.value)
  if (!domain) return null
  return { domain, value: `${PREFIX}${name.canonicalName};owner=${name.owner}`,
    key: JSON.stringify([name.canonicalName, name.owner, name.generation, name.serial, name.resolverId, website.value]) }
}

const empty = domain => ({ domain: domain ?? null, status: 'unverified', checkedAt: null, dnssec: false })

async function dnsJson(fetcher, endpoint, domain, timeoutMs) {
  const url = new URL(endpoint)
  url.searchParams.set('name', `_dusk-domains.${domain}`)
  url.searchParams.set('type', 'TXT')
  url.searchParams.set('do', 'true')
  const response = await fetcher(url.href, { headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok || !response.body) throw new Error('DNS resolver unavailable')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 65536) throw new Error('DNS answer too large')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (![0, 3].includes(result.Status) || (result.Answer !== undefined && !Array.isArray(result.Answer))) throw new Error('Invalid DNS answer')
  return result
}

async function lookup(claim, fetcher, timeoutMs) {
  for (const endpoint of RESOLVERS) {
    try {
      const result = await dnsJson(fetcher, endpoint, claim.domain, timeoutMs)
      const answers = result.Status === 0 ? (result.Answer ?? []).filter(row => row.type === 16
        && typeof row.name === 'string' && row.name.toLowerCase().replace(/\.$/, '') === `_dusk-domains.${claim.domain}`) : []
      const values = answers.map(row => parseTxt(row.data)).filter(value => value !== null)
      const status = values.includes(claim.value) ? 'verified' : values.some(value => value.startsWith(PREFIX)) ? 'mismatch' : 'unverified'
      const ttl = Math.min(MAX_AGE_MS, ...answers.map(row => Number.isFinite(row.TTL) && row.TTL >= 0 ? row.TTL * 1000 : 0))
      return { status, dnssec: result.AD === true, age: status === 'verified' ? Math.max(MIN_RECHECK_MS, ttl) : Number.POSITIVE_INFINITY }
    } catch { /* Try the next fixed resolver; errors never preserve a badge. */ }
  }
  return { status: 'unverified', dnssec: false, error: true }
}

export function createWebsiteVerification(storeProvider, { fetcher = globalThis.fetch, now = Date.now, timeoutMs = 3000, maxEntries = 100_000 } = {}) {
  const entries = new Map()
  // Keep scheduling history for eligible bindings even when their cached result is evicted.
  // Otherwise eviction would automatically recheck names that never had proof.
  const schedules = new Map()
  let active = 0, timer = null, recheckTimer = null, ticking = false
  const storeNow = async () => typeof storeProvider === 'function' ? storeProvider() : storeProvider
  const retry = domain => ({ ...empty(domain), status: 'retry' })

  function read(store, node) {
    const claim = binding(store, node), entry = entries.get(node)
    if (!claim || entry?.key !== claim.key) {
      return claim && schedules.get(node)?.key === claim.key ? retry(claim.domain) : empty(claim?.domain)
    }
    return { ...entry.result }
  }

  function scheduleRecheck() {
    clearTimeout(recheckTimer)
    if (!timer || ticking || active >= 8) return
    let next = Infinity
    for (const [node, schedule] of schedules) {
      if (!entries.get(node)?.pending) next = Math.min(next, schedule.recheckAt)
    }
    if (Number.isFinite(next)) {
      recheckTimer = setTimeout(() => { void tick() }, Math.max(1, next - now()))
      recheckTimer.unref?.()
    }
  }

  function makeRoom() {
    if (entries.size < maxEntries) return true
    for (const verified of [false, true]) {
      for (const [node, entry] of entries) {
        if (!entry.pending && (entry.result.status === 'verified') === verified) {
          entries.delete(node)
          return true
        }
      }
    }
    return false
  }

  async function check(node) {
    const store = await storeNow(), claim = binding(store, node)
    if (!claim) { entries.delete(node); schedules.delete(node); return empty() }
    const previous = entries.get(node)
    if (previous?.key === claim.key && previous.pending) return previous.pending
    if (active >= 8 || (!previous && !makeRoom())) return retry(claim.domain)
    active++
    const priorSchedule = schedules.get(node)
    const schedule = priorSchedule?.key === claim.key ? priorSchedule : { key: claim.key, lastGoodVerified: false, failures: 0 }
    const entry = { key: claim.key, result: previous?.key === claim.key && previous.result.status === 'verified'
      ? previous.result : { ...empty(claim.domain), status: 'checking' }, pending: null }
    entries.delete(node)
    entries.set(node, entry)
    entry.pending = (async () => {
      try {
        const result = await lookup(claim, fetcher, timeoutMs)
        const latest = await storeNow()
        if (entries.get(node) !== entry || binding(latest, node)?.key !== claim.key) {
          if (entries.get(node) === entry) entries.delete(node)
          return empty(binding(latest, node)?.domain)
        }
        entry.result = { domain: claim.domain, status: result.status, checkedAt: new Date(now()).toISOString(), dnssec: result.dnssec }
        if (result.error) {
          const delay = RETRY_MINUTES[Math.min(schedule.failures++, RETRY_MINUTES.length - 1)] * 60_000
          schedule.recheckAt = schedule.lastGoodVerified ? now() + delay : Infinity
        } else {
          schedule.lastGoodVerified = result.status === 'verified'
          schedule.failures = 0
          schedule.recheckAt = now() + result.age
        }
        schedules.set(node, schedule)
        return { ...entry.result }
      } catch {
        entries.delete(node)
        return retry(claim.domain)
      } finally { entry.pending = null; active--; scheduleRecheck() }
    })()
    return entry.pending
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const store = await storeNow()
      if (store.unavailable) { entries.clear(); schedules.clear(); return }
      for (const node of new Set([...entries.keys(), ...schedules.keys()])) {
        if (!binding(store, node)) { entries.delete(node); schedules.delete(node) }
      }
      // Four at a time leave capacity for manual checks, without an unbounded request queue.
      let pending = []
      for (const node of new Set([...store.namesByNode.keys(), ...store.subnamesByNode.keys()])) {
        const claim = binding(store, node), schedule = schedules.get(node)
        if (claim && !entries.get(node)?.pending && (schedule?.key !== claim.key || schedule.recheckAt <= now())) pending.push(check(node))
        if (pending.length === 4) { await Promise.all(pending); pending = [] }
      }
      await Promise.all(pending)
    } catch { entries.clear(); schedules.clear() }
    finally { ticking = false; scheduleRecheck() }
  }

  return { read, check, tick,
    start() {
      if (timer) return
      timer = setInterval(() => { void tick() }, 60_000)
      timer.unref?.()
      void tick()
    },
    stop() { clearInterval(timer); clearTimeout(recheckTimer); timer = null },
  }
}
