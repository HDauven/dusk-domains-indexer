import { describe, expect, it } from 'vitest'
import {
  controllerEventTypes,
  feeConfigEventTypes,
  lifecycleEventTypes,
  referralEventTypes,
  resolverEventTypes,
  reverseEventTypes,
  subnameEventTypes,
  treasuryEventTypes,
} from '@hdauven/dusk-domains-sdk/event-catalog'
import {
  isControllerEvent,
  isFeeConfigEvent,
  isLifecycleEvent,
  isReferralEvent,
  isResolverEvent,
  isReverseEvent,
  isSubnameEvent,
  isTreasuryEvent,
} from './event-types.mjs'

describe('local indexer event type router', () => {
  it('uses the shared Dusk Domains event catalog for every event family', () => {
    expect(controllerEventTypes.every(isControllerEvent)).toBe(true)
    expect(lifecycleEventTypes.every(isLifecycleEvent)).toBe(true)
    expect(resolverEventTypes.every(isResolverEvent)).toBe(true)
    expect(reverseEventTypes.every(isReverseEvent)).toBe(true)
    expect(subnameEventTypes.every(isSubnameEvent)).toBe(true)
    expect(treasuryEventTypes.every(isTreasuryEvent)).toBe(true)
    expect(referralEventTypes.every(isReferralEvent)).toBe(true)
    expect(feeConfigEventTypes.every(isFeeConfigEvent)).toBe(true)
  })

  it('does not route unknown event types into a projector family', () => {
    const unknown = 'unknown_event_type'
    expect(isControllerEvent(unknown)).toBe(false)
    expect(isLifecycleEvent(unknown)).toBe(false)
    expect(isResolverEvent(unknown)).toBe(false)
    expect(isReverseEvent(unknown)).toBe(false)
    expect(isSubnameEvent(unknown)).toBe(false)
    expect(isTreasuryEvent(unknown)).toBe(false)
    expect(isReferralEvent(unknown)).toBe(false)
    expect(isFeeConfigEvent(unknown)).toBe(false)
  })
})
