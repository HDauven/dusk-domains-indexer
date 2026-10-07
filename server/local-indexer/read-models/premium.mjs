import { registrationPremiumSchedule } from '@duskdomains/sdk'
import { RESERVED_LABELS, DEFAULT_FEE_CONFIG } from '../constants.mjs'
import { lifecycleClock } from './lifecycle.mjs'

export function premiumForName(store, lifecycle, now = lifecycleClock(store)) {
  const empty = { premiumLux: '0', premiumEndsAt: null, premiumEndsAtBlockHeight: null, premiumNextStepAt: null, premiumNextStepBlockHeight: null }
  const labels = lifecycle?.canonicalName?.split('.') ?? []
  const reserved = store.policy?.config?.reserved ?? [...RESERVED_LABELS]
  if (labels.length !== 2 || reserved.includes(labels[0]) || lifecycle.issuedAsReserved) return empty
  let grace = lifecycle.graceEndsAtBlockHeight
  let height = now.blockHeight
  const hasHeights = grace != null && height != null
    && /^(0|[1-9][0-9]*)$/.test(String(grace)) && /^(0|[1-9][0-9]*)$/.test(String(height))
  if (!hasHeights) {
    const graceMs = Date.parse(lifecycle.graceEndsAt)
    if (!Number.isFinite(graceMs) || graceMs > now.date.getTime()) return empty
    grace = 0
    height = Math.floor((now.date.getTime() - graceMs) / 10_000)
  }
  const schedule = registrationPremiumSchedule({
    premiumStartLux: (store.feeConfig ?? DEFAULT_FEE_CONFIG).premiumStartLux ?? 0,
    graceEndsAtBlockHeight: BigInt(grace),
    currentBlockHeight: BigInt(height),
    nowSeconds: hasHeights ? Math.floor(now.date.getTime() / 1_000) : Math.floor(Date.parse(lifecycle.graceEndsAt) / 1_000) + height * 10,
  })
  return {
    premiumLux: schedule.premiumLux,
    premiumEndsAt: schedule.premiumEndsAt,
    premiumEndsAtBlockHeight: hasHeights ? safeHeight(schedule.premiumEndsAtBlockHeight) : null,
    premiumNextStepAt: schedule.nextStepAt,
    premiumNextStepBlockHeight: hasHeights ? safeHeight(schedule.nextStepBlockHeight) : null,
  }
}

function safeHeight(n) { return n === null ? null : n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString() }
