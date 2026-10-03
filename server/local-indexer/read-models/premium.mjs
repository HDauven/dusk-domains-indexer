import { registrationPremiumSchedule } from '@duskdomains/sdk/projection'
import { RESERVED_LABELS, DEFAULT_FEE_CONFIG } from '../constants.mjs'
import { lifecycleClock } from './lifecycle.mjs'

export function premiumForName(store, lifecycle, now = lifecycleClock(store)) {
  const empty = { premiumLux: 0, premiumEndsAt: null, premiumEndsAtBlockHeight: null, premiumNextStepAt: null, premiumNextStepBlockHeight: null }
  const labels = lifecycle?.canonicalName?.split('.') ?? []
  if (labels.length !== 2 || RESERVED_LABELS.has(labels[0]) || lifecycle.issuedAsReserved) return empty
  let grace = lifecycle.graceEndsAtBlockHeight
  let height = now.blockHeight
  const hasHeights = Number.isSafeInteger(grace) && Number.isSafeInteger(height)
  if (!hasHeights) {
    const graceMs = Date.parse(lifecycle.graceEndsAt)
    if (!Number.isFinite(graceMs) || graceMs > now.date.getTime()) return empty
    grace = 0
    height = Math.floor((now.date.getTime() - graceMs) / 10_000)
  }
  const schedule = registrationPremiumSchedule({
    premiumStartLux: (store.feeConfig ?? DEFAULT_FEE_CONFIG).premiumStartLux ?? 0,
    graceEndsAtBlockHeight: grace,
    currentBlockHeight: height,
    nowSeconds: hasHeights ? now.date.getTime() / 1_000 : Date.parse(lifecycle.graceEndsAt) / 1_000 + height * 10,
  })
  return {
    premiumLux: schedule.premiumLux,
    premiumEndsAt: schedule.premiumEndsAt,
    premiumEndsAtBlockHeight: hasHeights ? schedule.premiumEndsAtBlockHeight : null,
    premiumNextStepAt: schedule.nextStepAt,
    premiumNextStepBlockHeight: hasHeights ? schedule.nextStepBlockHeight : null,
  }
}
