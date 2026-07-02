export const fixtureNode = `0x${'11'.repeat(32)}`
export const fixtureParentNode = `0x${'12'.repeat(32)}`
export const fixtureSubnameNode = `0x${'13'.repeat(32)}`
export const fixtureCommitment = `0x${'aa'.repeat(32)}`
export const fixtureOwner = `0x${'22'.repeat(32)}`
export const fixtureManager = `0x${'33'.repeat(32)}`
export const fixtureNextManager = `0x${'34'.repeat(32)}`
export const fixtureResolver = `0x${'44'.repeat(32)}`
export const fixtureReferrer = 'moonlight:0x5555555555555555555555555555555555555555555555555555555555555555'
export const fixtureBuyer = 'moonlight:0x6666666666666666666666666666666666666666666666666666666666666666'
export const fixtureMoonlightAddress = 'dusk1publicaddress'

export function createIndexerParityEvents() {
  return [
    envelope({
      type: 'registration_committed',
      commitment: fixtureCommitment,
      controller: fixtureOwner,
      createdAt: '2026-06-27T12:00:00.000Z',
    }, { blockHeight: 10, txId: 'commit-tx' }),
    envelope({
      type: 'registration_revealed',
      commitment: fixtureCommitment,
      node: fixtureNode,
      controller: fixtureOwner,
    }, { blockHeight: 15, txId: 'reveal-tx' }),
    envelope({
      type: 'name_registered',
      node: fixtureNode,
      label: 'aurora',
      actor: fixtureOwner,
      owner: fixtureOwner,
      expiresAt: '2028-06-27T12:00:00.000Z',
      graceEndsAt: '2028-07-27T12:00:00.000Z',
      expiresAtBlockHeight: 6_000_000,
      graceEndsAtBlockHeight: 6_259_200,
      feeLux: 10_000_000_000,
    }, { blockHeight: 20, txId: 'register-tx' }),
    envelope({
      type: 'name_owner_changed',
      node: fixtureNode,
      actor: fixtureOwner,
      previousOwner: null,
      owner: fixtureOwner,
      manager: fixtureManager,
      resolver: fixtureResolver,
      expiresAt: '2028-06-27T12:00:00.000Z',
      expiresAtBlockHeight: 6_000_000,
    }, { blockHeight: 21, txId: 'owner-tx' }),
    envelope({
      type: 'name_registered',
      node: fixtureParentNode,
      label: 'archive',
      actor: fixtureOwner,
      owner: fixtureOwner,
      expiresAt: '2027-06-27T12:00:00.000Z',
      graceEndsAt: '2027-07-27T12:00:00.000Z',
      expiresAtBlockHeight: 3_000_000,
      graceEndsAtBlockHeight: 3_259_200,
      feeLux: 10_000_000_000,
    }, { blockHeight: 36, txId: 'archive-register-tx' }),
    envelope({
      type: 'name_renewed',
      node: fixtureParentNode,
      actor: fixtureOwner,
      expiresAt: '2028-06-27T12:00:00.000Z',
      graceEndsAt: '2028-07-27T12:00:00.000Z',
      expiresAtBlockHeight: 6_000_000,
      graceEndsAtBlockHeight: 6_259_200,
      feeLux: 10_000_000_000,
    }, { blockHeight: 37, txId: 'archive-renew-tx' }),
    envelope({
      type: 'resolver_changed',
      node: fixtureParentNode,
      actor: fixtureOwner,
      resolver: fixtureResolver,
    }, { blockHeight: 38, txId: 'archive-resolver-tx' }),
    envelope({
      type: 'name_expired',
      node: fixtureParentNode,
      label: 'archive',
      actor: fixtureOwner,
      owner: fixtureOwner,
      expiresAt: '2028-06-27T12:00:00.000Z',
      graceEndsAt: '2028-07-27T12:00:00.000Z',
      expiresAtBlockHeight: 6_000_000,
      graceEndsAtBlockHeight: 6_259_200,
      observedAt: '2028-07-28T12:00:00.000Z',
    }, { blockHeight: 39, txId: 'archive-expire-tx' }),
    envelope({
      type: 'name_released',
      node: fixtureParentNode,
      label: 'archive',
      actor: fixtureOwner,
      previousOwner: fixtureOwner,
      releasedAt: '2028-07-28T12:01:00.000Z',
    }, { blockHeight: 40, txId: 'archive-release-tx' }),
    envelope({
      type: 'record_changed',
      node: fixtureNode,
      controller: fixtureManager,
      record: {
        key: 'moonlight_address',
        value: fixtureMoonlightAddress,
        visibility: 'public',
        updatedAt: '2026-06-27T12:02:00.000Z',
        updatedAtBlockHeight: 22,
        ttlSeconds: 300,
      },
    }, { blockHeight: 22, txId: 'record-tx' }),
    envelope({
      type: 'record_changed',
      node: fixtureNode,
      controller: fixtureManager,
      record: {
        key: 'website',
        value: 'https://old.example',
        visibility: 'public',
        updatedAt: '2026-06-27T12:02:30.000Z',
        updatedAtBlockHeight: 23,
        ttlSeconds: 300,
      },
    }, { blockHeight: 23, txId: 'website-tx' }),
    envelope({
      type: 'record_cleared',
      node: fixtureNode,
      controller: fixtureManager,
      key: 'website',
    }, { blockHeight: 24, txId: 'website-clear-tx' }),
    envelope({
      type: 'primary_name_changed',
      endpoint: {
        type: 'moonlight_address',
        value: fixtureMoonlightAddress,
      },
      controller: fixtureManager,
      node: fixtureNode,
      name: 'aurora.dusk',
      previousName: null,
      updatedAt: '2026-06-27T12:03:00.000Z',
    }, { blockHeight: 25, txId: 'primary-tx' }),
    envelope({
      type: 'primary_name_changed',
      endpoint: {
        type: 'moonlight_address',
        value: fixtureMoonlightAddress,
      },
      controller: fixtureManager,
      node: fixtureNode,
      name: '',
      previousName: 'aurora.dusk',
      updatedAt: '2026-06-27T12:03:30.000Z',
    }, { blockHeight: 26, txId: 'primary-clear-tx' }),
    envelope({
      type: 'subname_created',
      parentNode: fixtureNode,
      node: fixtureSubnameNode,
      parentName: 'aurora.dusk',
      name: 'pay.aurora.dusk',
      label: 'pay',
      actor: fixtureOwner,
      owner: fixtureOwner,
      manager: fixtureManager,
      resolver: fixtureResolver,
      expiresAt: '2028-06-27T12:00:00.000Z',
      parentExpiresAt: '2028-06-27T12:00:00.000Z',
      expiresAtBlockHeight: 6_000_000,
      parentExpiresAtBlockHeight: 6_000_000,
      expiryPolicy: 'inherits_parent',
      revocationPolicy: 'parent_revocable',
      createdAt: '2026-06-27T12:04:00.000Z',
    }, { blockHeight: 27, txId: 'subname-tx' }),
    envelope({
      type: 'subname_delegated',
      parentNode: fixtureNode,
      node: fixtureSubnameNode,
      name: 'pay.aurora.dusk',
      actor: fixtureOwner,
      manager: fixtureNextManager,
      delegatedAt: '2026-06-27T12:04:30.000Z',
    }, { blockHeight: 28, txId: 'subname-delegate-tx' }),
    envelope({
      type: 'subname_revoked',
      parentNode: fixtureNode,
      node: fixtureSubnameNode,
      name: 'pay.aurora.dusk',
      actor: fixtureOwner,
      revokedAt: '2026-06-27T12:05:00.000Z',
    }, { blockHeight: 29, txId: 'subname-revoke-tx' }),
    envelope({
      type: 'treasury_initialized',
      operator: principal(0x77),
      operatorRecipient: '244Sywxj7PuMHpcPxemaXLcrY5rPgztra6H9Vz8cU1Ro5v23SxKTfVqr2yS7NXAXE1iq59ndn4aMZmYxuzu3Te3e9fokQKTUkYvFxYg2P2E8EEg1gWUbs3AFL2aNx62HQd7r',
      allowedFeeSources: [fixtureNode],
    }, { blockHeight: 30, txId: 'treasury-init-tx', contractKey: 'treasury' }),
    envelope({
      type: 'treasury_operator_changed',
      previousOperator: principal(0x77),
      operator: principal(0x78),
      operatorRecipient: '244Sywxj7PuMHpcPxemaXLcrY5rPgztra6H9Vz8cU1Ro5v23SxKTfVqr2yS7NXAXE1iq59ndn4aMZmYxuzu3Te3e9fokQKTUkYvFxYg2P2E8EEg1gWUbs3AFL2aNx62HQd7r',
    }, { blockHeight: 30, txId: 'treasury-operator-tx', contractKey: 'treasury' }),
    envelope({
      type: 'treasury_fee_received',
      sourceContract: fixtureNode,
      reason: 'registration',
      node: fixtureNode,
      amountLux: 10_000_000_000,
      totalReceivedLux: 10_000_000_000,
      availableLux: 8_000_000_000,
      registrationReceivedLux: 10_000_000_000,
      renewalReceivedLux: 0,
      otherReceivedLux: 0,
    }, { blockHeight: 31, txId: 'treasury-fee-tx', contractKey: 'treasury' }),
    envelope({
      type: 'referral_reward_accrued',
      referrer: fixtureReferrer,
      buyer: fixtureBuyer,
      amountLux: 2_000_000_000,
      claimableLux: 2_000_000_000,
      claimedLux: 0,
      referralCount: 1,
    }, { blockHeight: 32, txId: 'referral-tx', contractKey: 'treasury' }),
    envelope({
      type: 'treasury_claimed',
      operator: principal(0x77),
      operatorRecipient: '244Sywxj7PuMHpcPxemaXLcrY5rPgztra6H9Vz8cU1Ro5v23SxKTfVqr2yS7NXAXE1iq59ndn4aMZmYxuzu3Te3e9fokQKTUkYvFxYg2P2E8EEg1gWUbs3AFL2aNx62HQd7r',
      amountLux: 8_000_000_000,
      remainingLux: 0,
    }, { blockHeight: 33, txId: 'treasury-claim-tx', contractKey: 'treasury' }),
    envelope({
      type: 'referral_reward_claimed',
      referrer: fixtureReferrer,
      amountLux: 2_000_000_000,
      remainingLux: 0,
      claimedLux: 2_000_000_000,
      referralCount: 1,
    }, { blockHeight: 34, txId: 'referral-claim-tx', contractKey: 'treasury' }),
    envelope({
      type: 'fee_config_updated',
      operator: fixtureOwner,
      previousConfig: feeConfig(1),
      config: feeConfig(2),
    }, { blockHeight: 35, txId: 'fee-config-tx' }),
  ]
}

function envelope(event, meta = {}) {
  return {
    event,
    meta: {
      txId: null,
      blockHeight: null,
      ...meta,
    },
  }
}

function principal(seed) {
  return {
    kind: 'Phoenix',
    bytes: Array.from({ length: 32 }, () => seed),
  }
}

function feeConfig(seed) {
  return {
    threeCharYearLux: seed,
    fourCharYearLux: seed + 1,
    fivePlusYearLux: seed + 2,
    referralRewardBps: seed + 3,
    renewalReferralRewardBps: seed + 4,
    premiumReferralRewardBps: seed + 5,
    version: seed + 6,
    updatedAt: seed + 7,
  }
}
