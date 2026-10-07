import { premiumForName } from './premium.mjs'
import {
  DEFAULT_FEE_CONFIG,
  RESERVED_LABELS,
  RESERVED_REASONS,
} from '../constants.mjs'
import {
  annualPrice,
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
  const label = canonical.split('.').at(-2) ?? ''
  const policy = store.policy?.config
  const lifecycle = store.lifecyclesByCanonical?.get(canonical)
    ?? store.namesByCanonical.get(canonical)?.lifecycle
  const premium = premiumForName(store, lifecycle)
  const issues = []
  const now = lifecycleClock(store)
  let status = canonical ? 'available' : 'invalid'
  let reserved

  const issue = nameValidationIssue(canonical) ?? (label.length < (policy?.minimum_root_bytes ?? 3)
    ? { tone: 'danger', text: 'Root label is shorter than the policy minimum.' } : null)
  if (issue) {
    status = 'invalid'
    issues.push(issue)
  } else if (indexedLifecycleBlocksRegistration(store.namesByCanonical.get(canonical)?.lifecycle, now)) {
    status = 'registered'
  } else if (indexedSubnameBlocksRegistration(store, store.subnamesByCanonical?.get(canonical), now)) {
    status = 'registered'
  } else if (canonical.split('.').length === 2 && (policy?.reserved ?? [...RESERVED_LABELS]).includes(label)) {
    status = 'reserved'
    reserved = {
      label,
      category: reservedCategory(label),
      reason: RESERVED_REASONS[label],
    }
    issues.push({ tone: 'warning', text: RESERVED_REASONS[label] })
  }

  if (policy?.denied.includes(label)) status = 'invalid'
  return {
    canonical,
    canonicalRaw: canonical,
    displayName: canonical,
    label,
    status,
    price: store.frozen && !policy ? null : annualPrice(label, store.feeConfig ?? DEFAULT_FEE_CONFIG) + premium.premiumLux / 1_000_000_000,
    ...premium,
    graceEndsAtBlockHeight: lifecycle?.graceEndsAtBlockHeight ?? null,
    issues,
    transactionBlocked: status !== 'available' || canonical.split('.').length !== 2 || Boolean(store.poolState?.registrationsPaused),
    policy: store.policy ?? null, renewalSchedule: store.renewalSchedule ?? null, estimate: true,
    ...(reserved ? { reserved } : {}),
  }
}
