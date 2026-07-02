import { describe, expect, it } from 'vitest'

import {
  emptyTreasuryState,
  reduceTreasuryEvent,
  reduceTreasuryReferralClaim,
  reduceTreasuryReferralReserve,
} from './treasury.mjs'

describe('treasury economics reducer', () => {
  it('moves accrued referral rewards out of operator-claimable funds', () => {
    const feeState = reduceTreasuryEvent({
      type: 'treasury_fee_received',
      sourceContract: `0x${'40'.repeat(32)}`,
      reason: 'registration',
      node: `0x${'42'.repeat(32)}`,
      amountLux: 500_000_000_000,
      totalReceivedLux: 500_000_000_000,
      availableLux: 500_000_000_000,
      registrationReceivedLux: 500_000_000_000,
      renewalReceivedLux: 0,
      otherReceivedLux: 0,
    }, emptyTreasuryState(), { txId: 'tx-register-fee', blockHeight: 100 })

    const accruedState = reduceTreasuryReferralReserve({
      type: 'referral_reward_accrued',
      amountLux: 100_000_000_000,
    }, feeState)

    expect(accruedState.availableLux).toBe(400_000_000_000)
    expect(accruedState.totalReceivedLux).toBe(500_000_000_000)
    expect(accruedState.referralClaimableLux).toBe(100_000_000_000)
    expect(accruedState.referralClaimedLux).toBe(0)
    expect(accruedState.referralCount).toBe(1)

    const claimedState = reduceTreasuryReferralClaim({
      type: 'referral_reward_claimed',
      amountLux: 100_000_000_000,
    }, accruedState)

    expect(claimedState.availableLux).toBe(400_000_000_000)
    expect(claimedState.referralClaimableLux).toBe(0)
    expect(claimedState.referralClaimedLux).toBe(100_000_000_000)
  })
})
