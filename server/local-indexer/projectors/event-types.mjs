import {
  isControllerEventType,
  isFeeConfigEventType,
  isLifecycleEventType,
  isMarketplaceEventType,
  isReferralEventType,
  isResolverEventType,
  isReverseEventType,
  isSubnameEventType,
  isTreasuryEventType,
} from '@duskdomains/sdk/event-catalog'

export function isLifecycleEvent(type) {
  return isLifecycleEventType(type)
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
  return isSubnameEventType(type)
}

export function isTreasuryEvent(type) {
  return isTreasuryEventType(type)
}

export function isReferralEvent(type) {
  return isReferralEventType(type)
}

export function isFeeConfigEvent(type) {
  return isFeeConfigEventType(type)
}

export function isMarketplaceEvent(type) {
  return isMarketplaceEventType(type)
}
