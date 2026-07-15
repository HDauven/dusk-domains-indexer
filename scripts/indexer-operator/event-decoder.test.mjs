import { describe, expect, it } from 'vitest'
import { normalizeObservedEvent } from './event-decoder.mjs'
import { bytesToBase58 } from './event-value-codecs.mjs'

const observedAt = '2026-06-27T12:00:00.000Z'
const contract = {
  key: 'core',
  contractId: '77'.repeat(32),
}
const treasuryContract = {
  key: 'treasury',
  contractId: '66'.repeat(32),
}
const marketplaceContract = {
  key: 'marketplace',
  contractId: '55'.repeat(32),
}

describe('Dusk Domains indexer event decoder', () => {
  it('rejects u64 values that JavaScript cannot represent exactly', () => {
    expect(() => normalizeObservedEvent({
      contract: marketplaceContract,
      eventName: 'domain_offer_placed',
      observedAt,
      event: {
        node: bytes(0x11),
        buyer_authority: bytes(0x22),
        amount_lux: 9_007_199_254_740_993n,
        fee_bps: 250,
        expires_at: 100,
        placed_at: 50,
      },
    })).toThrow('unsafe numeric value')

    expect(() => normalizeObservedEvent({
      contract: marketplaceContract,
      eventName: 'domain_offer_placed',
      observedAt,
      event: {
        node: bytes(0x11),
        buyer_authority: bytes(0x22),
        amount_lux: '9007199254740993',
        fee_bps: 250,
        expires_at: 100,
        placed_at: 50,
      },
    })).toThrow('unsafe numeric value')
  })

  it('normalizes block-based registration timing into ISO timestamps and block heights', () => {
    const normalized = normalizeObservedEvent({
      contract,
      eventName: 'name_registered',
      observedAt,
      targetBlockSeconds: 10,
      event: {
        node: bytes(0x11),
        label: 'aurora',
        actor: bytes(0x22),
        owner: bytes(0x33),
        expires_at: 5,
        grace_ends_at: 8,
        fee_lux: 10_000_000_000,
      },
    })

    expect(normalized).toEqual({
      event: {
        type: 'name_registered',
        node: hex(0x11),
        label: 'aurora',
        actor: hex(0x22),
        owner: hex(0x33),
        expiresAt: '2026-06-27T12:00:50.000Z',
        graceEndsAt: '2026-06-27T12:01:20.000Z',
        expiresAtBlockHeight: 5,
        graceEndsAtBlockHeight: 8,
        feeLux: 10_000_000_000,
      },
      meta: {
        txId: null,
        blockHeight: null,
        source: 'w3sper-live-subscription',
        observedAt,
        contractKey: 'core',
        contractId: `0x${'77'.repeat(32)}`,
      },
    })
  })

  it('normalizes every collected protocol event into an envelope', () => {
    for (const [eventName, event, expectedType, targetContract = contract] of collectedEventFixtures()) {
      const normalized = normalizeObservedEvent({
        contract: targetContract,
        eventName,
        event,
        observedAt,
      })

      expect(normalized?.event?.type, eventName).toBe(expectedType)
      expect(normalized?.meta?.contractKey, eventName).toBe(targetContract.key)
      expect(normalized?.meta?.contractId, eventName).toMatch(/^0x[0-9a-f]{64}$/u)
    }
  })

  it('fails closed for unsupported event names', () => {
    expect(normalizeObservedEvent({
      contract,
      eventName: 'unknown_event',
      observedAt,
      event: {},
    })).toBeNull()
  })

  it('normalizes raw Moonlight endpoint bytes to Dusk account strings', () => {
    const node = bytes(0x11)
    const actor = bytes(0x22)
    const publicKey = bytes(0x2a, 96)
    const expectedAddress = bytesToBase58(publicKey)

    expect(normalizeObservedEvent({
      contract,
      eventName: 'record_changed',
      observedAt,
      event: {
        node,
        controller: actor,
        record: {
          key: 'moonlight_address',
          value: publicKey,
          updated_at: 40,
          ttl_seconds: 300,
        },
      },
    })?.event).toMatchObject({
      record: {
        value: expectedAddress,
      },
    })

    expect(normalizeObservedEvent({
      contract,
      eventName: 'primary_name_changed',
      observedAt,
      event: {
        endpoint: { kind: 'MoonlightAddress', value: publicKey },
        controller: actor,
        node,
        name: 'aurora.dusk',
        previous_name: null,
        updated_at: 41,
      },
    })?.event).toMatchObject({
      endpoint: {
        value: expectedAddress,
      },
    })
  })
})

function collectedEventFixtures() {
  const node = bytes(0x11)
  const parentNode = bytes(0x12)
  const actor = bytes(0x22)
  const owner = bytes(0x33)
  const manager = bytes(0x44)
  const resolver = bytes(0x55)
  const commitment = bytes(0x66)
  const operator = principal(0x77)

  return [
    ['registration_committed', { commitment, controller: actor, created_at: 19 }, 'registration_committed'],
    ['registration_revealed', { commitment, node, controller: actor }, 'registration_revealed'],
    ['name_registered', { node, label: 'aurora', actor, owner, expires_at: 10, grace_ends_at: 13, fee_lux: 1 }, 'name_registered'],
    ['name_renewed', { node, actor, expires_at: 20, grace_ends_at: 23, fee_lux: 2 }, 'name_renewed'],
    ['name_expired', { node, label: 'aurora', actor, owner, expires_at: 10, grace_ends_at: 13, observed_at: 14 }, 'name_expired'],
    ['name_released', { node, label: 'aurora', actor, previous_owner: owner, released_at: 15 }, 'name_released'],
    ['name_owner_changed', { node, actor, previous_owner: owner, owner, manager, resolver, expires_at: 30 }, 'name_owner_changed'],
    ['resolver_changed', { node, actor, resolver }, 'resolver_changed'],
    ['record_changed', {
      node,
      controller: actor,
      record: {
        key: 'moonlight_address',
        value: utf8Bytes('dusk1publicaddress'),
        updated_at: 40,
        ttl_seconds: 300,
      },
    }, 'record_changed'],
    ['record_cleared', { node, controller: actor, key: 'moonlight_address' }, 'record_cleared'],
    ['primary_name_changed', {
      endpoint: { kind: 'MoonlightAddress', value: utf8Bytes('dusk1publicaddress') },
      controller: actor,
      node,
      name: 'aurora.dusk',
      previous_name: null,
      updated_at: 41,
    }, 'primary_name_changed'],
    ['subname_created', {
      parent_node: parentNode,
      node,
      parent_name: 'aurora.dusk',
      name: 'pay.aurora.dusk',
      label: 'pay',
      actor,
      owner,
      manager,
      resolver,
      expires_at: 50,
      parent_expires_at: 60,
      expiry_policy: 'FixedBeforeParent',
      revocation_policy: 'Locked',
      created_at: 42,
    }, 'subname_created'],
    ['subname_delegated', { parent_node: parentNode, node, name: 'pay.aurora.dusk', actor, manager, delegated_at: 43 }, 'subname_delegated'],
    ['subname_revoked', { parent_node: parentNode, node, name: 'pay.aurora.dusk', actor, revoked_at: 44 }, 'subname_revoked'],
    ['core_referral_config_changed', {
      operator,
      previous_referral_reward_bps: 2_000,
      referral_reward_bps: 1_000,
    }, 'core_referral_config_changed'],
    ['fee_config_updated', {
      operator,
      previous_config: feeConfig(1),
      config: feeConfig(2),
    }, 'fee_config_updated'],
    ['treasury_initialized', {
      operator,
      operator_recipient: [1, 2, 3],
      allowed_fee_sources: [node],
    }, 'treasury_initialized', treasuryContract],
    ['treasury_operator_changed', {
      previous_operator: principal(0x76),
      operator,
      operator_recipient: [1, 2, 3],
    }, 'treasury_operator_changed', treasuryContract],
    ['treasury_fee_received', {
      source_contract: node,
      reason: 1,
      node,
      amount_lux: 1,
      total_received_lux: 2,
      available_lux: 3,
      registration_received_lux: 4,
      renewal_received_lux: 5,
      other_received_lux: 6,
    }, 'treasury_fee_received', treasuryContract],
    ['treasury_claimed', {
      operator,
      operator_recipient: [1, 2, 3],
      amount_lux: 1,
      remaining_lux: 2,
    }, 'treasury_claimed', treasuryContract],
    ['referral_reward_accrued', {
      referrer: principal(0x88),
      buyer: principal(0x89),
      node,
      amount_lux: 1,
      claimable_lux: 2,
      claimed_lux: 3,
      referral_count: 4,
    }, 'referral_reward_accrued', treasuryContract],
    ['referral_reward_claimed', {
      referrer: principal(0x88),
      referrer_recipient: [1, 2, 3],
      amount_lux: 1,
      remaining_lux: 2,
      claimed_lux: 3,
      referral_count: 4,
    }, 'referral_reward_claimed', treasuryContract],
    ['marketplace_initialized', {
      core_contract: node,
      treasury_contract: parentNode,
      marketplace_authority: actor,
      operator: owner,
      fee_bps: 250,
    }, 'marketplace_initialized', marketplaceContract],
    ['marketplace_config_updated', {
      operator: owner,
      previous_operator: actor,
      previous_fee_bps: 250,
      fee_bps: 300,
      updated_at: 45,
    }, 'marketplace_config_updated', marketplaceContract],
    ['domain_fixed_sale_opened', {
      node,
      name: 'aurora.dusk',
      seller_authority: owner,
      price_lux: 10,
      private_buyer: null,
      fee_bps: 300,
      expires_at: 100,
      opened_at: 46,
    }, 'domain_fixed_sale_opened', marketplaceContract],
    ['domain_fixed_sale_closed', {
      node,
      seller_authority: owner,
      expired: false,
      domain_expired: false,
      closed_at: 47,
    }, 'domain_fixed_sale_closed', marketplaceContract],
    ['domain_fixed_sale_filled', {
      node,
      name: 'aurora.dusk',
      seller_authority: owner,
      buyer_authority: actor,
      gross_amount_lux: 10,
      protocol_fee_lux: 1,
      seller_proceeds_lux: 9,
      filled_at: 48,
    }, 'domain_fixed_sale_filled', marketplaceContract],
    ['domain_auction_created', {
      node,
      name: 'aurora.dusk',
      seller_authority: owner,
      reserve_price_lux: 10,
      duration_blocks: 100,
      start_deadline: 500,
      fee_bps: 300,
      created_at: 49,
    }, 'domain_auction_created', marketplaceContract],
    ['domain_bid_placed', {
      node,
      bidder_authority: actor,
      amount_lux: 10,
      previous_bidder_authority: null,
      previous_bid_lux: 0,
      start_block: 50,
      end_block: 150,
      started: true,
      extended: false,
      bid_count: 1,
      placed_at: 50,
    }, 'domain_bid_placed', marketplaceContract],
    ['domain_auction_cancelled', {
      node,
      seller_authority: owner,
      expired: true,
      domain_expired: false,
      cancelled_at: 51,
    }, 'domain_auction_cancelled', marketplaceContract],
    ['domain_auction_settled', {
      node,
      name: 'aurora.dusk',
      seller_authority: owner,
      winner_authority: actor,
      gross_amount_lux: 10,
      protocol_fee_lux: 1,
      seller_proceeds_lux: 9,
      domain_expired: false,
      settled_at: 52,
    }, 'domain_auction_settled', marketplaceContract],
    ['domain_offer_placed', {
      node,
      buyer_authority: actor,
      amount_lux: 10,
      fee_bps: 300,
      expires_at: 100,
      placed_at: 53,
    }, 'domain_offer_placed', marketplaceContract],
    ['domain_offer_closed', {
      node,
      buyer_authority: actor,
      amount_lux: 10,
      expired: false,
      closed_at: 54,
    }, 'domain_offer_closed', marketplaceContract],
    ['domain_offer_accepted', {
      node,
      seller_authority: owner,
      buyer_authority: actor,
      gross_amount_lux: 10,
      protocol_fee_lux: 1,
      seller_proceeds_lux: 9,
      accepted_at: 55,
    }, 'domain_offer_accepted', marketplaceContract],
    ['marketplace_refund_claimed', {
      authority: actor,
      recipient: bytes(0x99, 96),
      amount_lux: 10,
      claimed_at: 56,
    }, 'marketplace_refund_claimed', marketplaceContract],
  ]
}

function feeConfig(seed) {
  return {
    three_char_year_lux: seed,
    four_char_year_lux: seed + 1,
    five_plus_year_lux: seed + 2,
    referral_reward_bps: seed + 3,
    renewal_referral_reward_bps: seed + 4,
    premium_referral_reward_bps: seed + 5,
    version: seed + 6,
    updated_at: seed + 7,
  }
}

function principal(seed) {
  return {
    kind: 'Phoenix',
    bytes: bytes(seed),
  }
}

function bytes(byte, length = 32) {
  return Array.from({ length }, () => byte)
}

function utf8Bytes(value) {
  return [...new TextEncoder().encode(value)]
}

function hex(byte) {
  return `0x${byte.toString(16).padStart(2, '0').repeat(32)}`
}
