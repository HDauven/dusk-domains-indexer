import { namehashHex, nameValidationIssue } from '../naming.mjs'
import {
  normalizeName,
  normalizeNode,
} from '../http.mjs'
import { createRecentChangeWarnings, validateResolverRecords } from '../records.mjs'
import {
  indexedSubnameBlocksRegistration,
  lifecycleClock,
  lifecycleMomentPassed,
  subnameLifecycle,
} from './lifecycle.mjs'

export function resolveForward(store, rawName) {
  const canonicalName = normalizeName(rawName)
  const now = new Date()
  const clock = lifecycleClock(store, now)

  if (nameValidationIssue(canonicalName)) {
    return emptyForwardResponse(canonicalName, now, {
      code: 'missing_name',
      message: 'Name is invalid or unavailable to the indexer.',
    })
  }

  const indexed = store.namesByCanonical.get(canonicalName)
    ?? indexedSubnameAsName(store, canonicalName, clock)

  if (!indexed) {
    return createForwardResponse({
      canonicalName,
      node: namehashHex(canonicalName),
      records: [],
      resolverId: null,
      resolverHealth: 'missing',
      expiresAt: null,
      expired: false,
      activity: [],
      now,
    })
  }

  return createForwardResponse({
    canonicalName,
    node: indexed.node,
    records: indexed.records,
    resolverId: indexed.resolverId,
    resolverHealth: indexed.resolverHealth ?? 'ok',
    expiresAt: indexed.expiresAt,
    expired: lifecycleMomentPassed(indexed.expiresAtBlockHeight, indexed.expiresAt, clock),
    activity: indexed.activity,
    now,
  })
}

function indexedSubnameAsName(store, canonicalName, clock) {
  const subname = store.subnamesByCanonical?.get(canonicalName)
  if (!indexedSubnameBlocksRegistration(store, subname, clock)) return null
  const node = normalizeNode(subname.node)
  const lifecycle = subnameLifecycle(subname)

  return {
    ...lifecycle,
    resolverHealth: subname.resolver ? 'ok' : 'missing',
    records: store.recordsByNode?.get(node) ?? [],
    activity: store.activityByNode.get(node) ?? [],
    lifecycle,
  }
}

function createForwardResponse(input) {
  const ttlSeconds = Math.min(
    300,
    ...input.records.map((record) => Number(record.ttlSeconds)).filter((ttl) => Number.isFinite(ttl) && ttl > 0),
  )
  const recordErrors = validateResolverRecords(input.records)
  const errors = [...recordErrors]

  if (!input.resolverId) {
    errors.push({ code: 'missing_resolver', message: `${input.canonicalName} does not define a resolver.` })
  }
  if (input.resolverId && input.resolverHealth === 'invalid') {
    errors.push({ code: 'invalid_resolver', message: `${input.canonicalName} resolver is invalid.` })
  }
  if (input.expired) {
    errors.push({ code: 'expired_name', message: `${input.canonicalName} has expired.` })
  }
  const resolverHealth = !input.resolverId
    ? 'missing'
    : input.resolverHealth === 'invalid' || recordErrors.length > 0
      ? 'invalid'
      : input.resolverHealth ?? 'ok'

  return {
    canonicalName: input.canonicalName,
    node: input.node,
    records: input.records,
    resolver: {
      resolverId: input.resolverId ?? null,
      health: resolverHealth,
    },
    expiry: {
      status: input.expired ? 'expired' : 'active',
      expiresAt: input.expiresAt ?? null,
    },
    cache: {
      asOf: input.now.toISOString(),
      ttlSeconds,
      staleAt: new Date(input.now.getTime() + ttlSeconds * 1000).toISOString(),
    },
    warnings: createRecentChangeWarnings(input.activity ?? [], input.now),
    verificationStatus: errors.length === 0 ? 'forward_resolved' : 'unverified',
    errors,
  }
}

function emptyForwardResponse(canonicalName, now, error) {
  return {
    canonicalName,
    node: '0x',
    records: [],
    resolver: {
      resolverId: null,
      health: 'missing',
    },
    expiry: {
      status: 'missing',
      expiresAt: null,
    },
    cache: {
      asOf: now.toISOString(),
      ttlSeconds: 0,
      staleAt: now.toISOString(),
    },
    warnings: [],
    verificationStatus: 'unverified',
    errors: [error],
  }
}
