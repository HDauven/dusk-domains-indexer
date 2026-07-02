import { eventTimestamp } from './event-log.mjs'

export function activityEntry(input) {
  return {
    id: [
      input.eventType,
      input.node,
      input.actor,
      input.meta?.txId ?? input.timestamp,
    ].filter(Boolean).join(':'),
    eventType: input.eventType,
    node: input.node,
    name: input.name,
    actor: input.actor,
    target: input.target ?? null,
    timestamp: input.timestamp,
    blockHeight: input.meta?.blockHeight ?? null,
    ...(input.meta?.txId ? { txId: input.meta.txId } : {}),
  }
}

export function lifecycleActivityType(type) {
  if (type === 'name_registered') return 'registration'
  if (type === 'name_renewed') return 'renewal'
  if (type === 'name_expired') return 'expiry'
  if (type === 'name_released') return 'release'
  if (type === 'name_owner_changed') return 'transfer'
  if (type === 'resolver_changed') return 'resolver_change'
  return 'record_update'
}

export function lifecycleActivityTarget(event) {
  if (event.type === 'name_registered') return event.owner
  if (event.type === 'name_renewed') return event.expiresAt
  if (event.type === 'name_expired') return event.observedAt
  if (event.type === 'name_released') return event.previousOwner
  if (event.type === 'name_owner_changed') return event.owner
  if (event.type === 'resolver_changed') return event.resolver
  return undefined
}

export function lifecycleTimestamp(event) {
  if (event.type === 'name_renewed') return event.expiresAt
  if (event.type === 'name_expired') return event.observedAt
  if (event.type === 'name_released') return event.releasedAt
  return undefined
}

export function subnameTimestamp(event) {
  if (event.type === 'subname_created') return event.createdAt
  if (event.type === 'subname_delegated') return event.delegatedAt
  return event.revokedAt
}

export function newestEventTimestamp(events) {
  const timestamps = events
    .map((entry) => {
      const event = entry?.event ?? entry
      return eventTimestamp(event, entry?.meta ?? {})
    })
    .map((timestamp) => timestamp ? new Date(timestamp).getTime() : NaN)
    .filter(Number.isFinite)
  if (timestamps.length === 0) return null
  return new Date(Math.max(...timestamps)).toISOString()
}
