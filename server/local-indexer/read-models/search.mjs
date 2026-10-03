import { premiumForName } from './premium.mjs'
import {
  DEFAULT_FEE_CONFIG,
  RESERVED_LABELS,
  RESERVED_REASONS,
} from '../constants.mjs'
import {
  annualPrice,
  apexLabel,
  nameValidationIssue,
  reservedCategory,
} from '../naming.mjs'
import { normalizeName } from '../http.mjs'
import {
  indexedLifecycleBlocksRegistration,
  indexedSubnameBlocksRegistration,
  lifecycleClock,
} from './lifecycle.mjs'

export function searchName(store, query) {
  const canonical = normalizeName(query)
  const label = apexLabel(canonical)
  const lifecycle = store.lifecyclesByCanonical?.get(canonical)
    ?? store.namesByCanonical.get(canonical)?.lifecycle
  const premium = premiumForName(store, lifecycle)
  const issues = []
  const now = lifecycleClock(store)
  let status = canonical ? 'available' : 'invalid'
  let reserved

  const issue = nameValidationIssue(canonical)
  if (issue) {
    status = 'invalid'
    issues.push(issue)
  } else if (indexedLifecycleBlocksRegistration(store.namesByCanonical.get(canonical)?.lifecycle, now)) {
    status = 'registered'
  } else if (indexedSubnameBlocksRegistration(store, store.subnamesByCanonical?.get(canonical), now)) {
    status = 'registered'
  } else if (canonical.split('.').length === 2 && RESERVED_LABELS.has(label)) {
    status = 'reserved'
    reserved = {
      label,
      category: reservedCategory(label),
      reason: RESERVED_REASONS[label],
    }
    issues.push({ tone: 'warning', text: RESERVED_REASONS[label] })
  }

  return {
    canonical,
    canonicalRaw: canonical,
    displayName: canonical,
    label,
    status,
    price: annualPrice(label, store.feeConfig ?? DEFAULT_FEE_CONFIG) + premium.premiumLux / 1_000_000_000,
    ...premium,
    graceEndsAtBlockHeight: lifecycle?.graceEndsAtBlockHeight ?? null,
    issues,
    transactionBlocked: status !== 'available' || canonical.split('.').length !== 2,
    ...(reserved ? { reserved } : {}),
  }
}
