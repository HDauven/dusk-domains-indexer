import { eventTimestamp } from './event-log.mjs'

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
