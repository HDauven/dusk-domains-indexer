import {
  isControllerEventType,
  isFeeConfigEventType,
  isLifecycleEventType,
  isMarketplaceEventType,
  isPoolEventType,
  isReferralEventType,
  isResolverEventType,
  isReverseEventType,
  isTreasuryEventType,
} from '@duskdomains/sdk/event-catalog'

export function isLifecycleEvent(type) {
  return isLifecycleEventType(type) || type === 'reserved_name_issued'
}

export function isResolverEvent(type) {
  return isResolverEventType(type)
}

export function isReverseEvent(type) {
  return isReverseEventType(type)
}

export function isControllerEvent(type) {
  return isControllerEventType(type)
}

export function isSubnameEvent(type) {
  // The pinned catalog predates the v1 subname lifecycle.
  return type === 'subname_created' || type === 'subname_pruned'
}

// Recognize the new contract events with the pinned SDK as well as its next release.
export function isTreasuryEvent(type) {
  return isTreasuryEventType(type)
    || type === 'treasury_operator_proposed'
    || type === 'treasury_operator_cancelled'
}

export function isReferralEvent(type) {
  return isReferralEventType(type)
}

export function isFeeConfigEvent(type) {
  return isFeeConfigEventType(type)
}

export function isMarketplaceEvent(type) {
  return isMarketplaceEventType(type)
    || type === 'marketplace_operator_proposed'
    || type === 'marketplace_operator_cancelled'
    || type === 'marketplace_operator_changed'
}

export function isPoolEvent(type) {
  return isPoolEventType(type)
    || type === 'router_operator_proposed'
    || type === 'router_operator_cancelled'
}
