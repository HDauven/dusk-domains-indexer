import { premiumForName } from './premium.mjs'
import {
  DEFAULT_FEE_CONFIG,
  LUX_PER_DUSK,
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

  // The selected policy decides new registrations only, in its order: denied, reserved,
  // then minimum length (spec §4.1). A name held under an earlier policy stays registered.
  const issue = nameValidationIssue(canonical)
  if (issue) {
    status = 'invalid'
    issues.push(issue)
  } else if (indexedLifecycleBlocksRegistration(store.namesByCanonical.get(canonical)?.lifecycle, now)) {
    status = 'registered'
  } else if (indexedSubnameBlocksRegistration(store, store.subnamesByCanonical?.get(canonical), now)) {
    status = 'registered'
  } else if (policy?.denied.includes(label)) {
    status = 'invalid'
  } else if (canonical.split('.').length === 2 && (policy?.reserved ?? [...RESERVED_LABELS]).includes(label)) {
    status = 'reserved'
    // A replacement policy can reserve labels the launch list does not name.
    const reason = RESERVED_REASONS[label] ?? 'Reserved by the registration policy.'
    reserved = {
      label,
      category: reservedCategory(label),
      reason,
    }
    issues.push({ tone: 'warning', text: reason })
  } else if (label.length < (policy?.minimum_root_bytes ?? 3)) {
    status = 'invalid'
    issues.push({ tone: 'danger', text: 'Root label is shorter than the policy minimum.' })
  }

  return {
    canonical,
    canonicalRaw: canonical,
    displayName: canonical,
    label,
    status,
    // A selected policy without an authenticated configuration has no price, in every mode.
    price: (store.frozen || store.policy) && !policy ? null : policyAnnualPrice(label, policy, store.feeConfig) + premium.premiumLux / 1_000_000_000,
    ...premium,
    graceEndsAtBlockHeight: lifecycle?.graceEndsAtBlockHeight ?? null,
    issues,
    transactionBlocked: status !== 'available' || canonical.split('.').length !== 2 || Boolean(store.poolState?.registrationsPaused),
    policy: store.policy ?? null, renewalSchedule: store.renewalSchedule ?? null, estimate: true,
    ...(reserved ? { reserved } : {}),
  }
}

// Policy tiers are label lengths 1, 2, 3, 4 and 5–63 (spec §4.1). The policy quotes a root
// below its minimum as Denied, with zero amounts.
function policyAnnualPrice(label, policy, feeConfig = DEFAULT_FEE_CONFIG) {
  if (!policy) return annualPrice(label, feeConfig)
  if (label.length < policy.minimum_root_bytes) return 0
  return Number(policy.annual_lux[Math.min(Math.max(label.length, 1), 5) - 1]) / LUX_PER_DUSK
}
