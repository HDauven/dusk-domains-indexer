import {
  DEFAULT_FEE_CONFIG,
  RESERVED_LABELS,
  RESERVED_REASONS,
} from '../constants.mjs'
import {
  annualPrice,
  apexLabel,
  reservedCategory,
} from '../naming.mjs'
import { normalizeName } from '../http.mjs'
import {
  indexedLifecycleBlocksRegistration,
  indexedSubnameBlocksRegistration,
} from './lifecycle.mjs'

export function searchName(store, query) {
  const canonical = normalizeName(query)
  const label = apexLabel(canonical)
  const issues = []
  const now = new Date()
  let status = canonical ? 'available' : 'invalid'
  let reserved

  if (!canonical) {
    issues.push({ tone: 'info', text: 'Enter a name to check availability.' })
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\.dusk$/.test(canonical)) {
    status = 'invalid'
    issues.push({
      tone: 'danger',
      text: 'Use lowercase letters, numbers, or interior hyphens.',
    })
  } else if (canonical.length > 63) {
    status = 'invalid'
    issues.push({ tone: 'danger', text: 'Names must be 63 characters or shorter.' })
  } else if (canonical.split('.').filter((part) => part !== 'dusk').some((part) => part.length < 3)) {
    status = 'invalid'
    issues.push({ tone: 'danger', text: 'Labels shorter than 3 characters are reserved.' })
  } else if (RESERVED_LABELS.has(label)) {
    status = 'reserved'
    reserved = {
      label,
      category: reservedCategory(label),
      reason: RESERVED_REASONS[label],
    }
    issues.push({ tone: 'warning', text: RESERVED_REASONS[label] })
  } else if (indexedLifecycleBlocksRegistration(store.namesByCanonical.get(canonical)?.lifecycle, now)) {
    status = 'registered'
  } else if (indexedSubnameBlocksRegistration(store, store.subnamesByCanonical?.get(canonical), now)) {
    status = 'registered'
  }

  return {
    canonical,
    canonicalRaw: canonical,
    displayName: canonical,
    label,
    status,
    price: annualPrice(label, store.feeConfig ?? DEFAULT_FEE_CONFIG),
    issues,
    transactionBlocked: status !== 'available',
    ...(reserved ? { reserved } : {}),
  }
}
