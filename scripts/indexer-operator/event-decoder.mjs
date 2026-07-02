import {
  bytesToBase58,
  bytesToHex,
  bytesToUtf8,
  endpointKindToRecordKey,
  enumValue,
  feeConfigFromEvent,
  lifecycleValueToIso,
  numberOrNull,
  numericBlockHeight,
  principalFromEvent,
  treasuryReasonName,
  withHexPrefix,
} from './event-value-codecs.mjs'

const defaultTargetBlockSeconds = 10

export function normalizeObservedEvent({
  contract,
  eventName,
  event,
  observedAt,
  targetBlockSeconds = defaultTargetBlockSeconds,
}) {
  const meta = {
    txId: null,
    blockHeight: null,
    source: 'w3sper-live-subscription',
    observedAt,
    contractKey: contract.key,
    contractId: withHexPrefix(contract.contractId),
  }

  if (eventName === 'registration_committed') {
    const committedBlockHeight = numericBlockHeight(event.created_at)
    return {
      event: {
        type: 'registration_committed',
        commitment: bytesToHex(event.commitment),
        controller: bytesToHex(event.controller),
        createdAt: observedAt,
      },
      meta: {
        ...meta,
        blockHeight: committedBlockHeight,
      },
    }
  }

  if (eventName === 'registration_revealed') {
    return {
      event: {
        type: 'registration_revealed',
        commitment: bytesToHex(event.commitment),
        node: bytesToHex(event.node),
        controller: bytesToHex(event.controller),
      },
      meta,
    }
  }

  if (eventName === 'name_registered') {
    return {
      event: {
        type: 'name_registered',
        node: bytesToHex(event.node),
        label: event.label,
        actor: bytesToHex(event.actor),
        owner: bytesToHex(event.owner),
        expiresAt: lifecycleValueToIso(event.expires_at, observedAt, targetBlockSeconds),
        graceEndsAt: lifecycleValueToIso(event.grace_ends_at, observedAt, targetBlockSeconds),
        expiresAtBlockHeight: numberOrNull(event.expires_at),
        graceEndsAtBlockHeight: numberOrNull(event.grace_ends_at),
        feeLux: Number(event.fee_lux ?? 0),
      },
      meta,
    }
  }

  if (eventName === 'name_renewed') {
    return {
      event: {
        type: 'name_renewed',
        node: bytesToHex(event.node),
        actor: bytesToHex(event.actor),
        expiresAt: lifecycleValueToIso(event.expires_at, observedAt, targetBlockSeconds),
        graceEndsAt: lifecycleValueToIso(event.grace_ends_at, observedAt, targetBlockSeconds),
        expiresAtBlockHeight: numberOrNull(event.expires_at),
        graceEndsAtBlockHeight: numberOrNull(event.grace_ends_at),
        feeLux: Number(event.fee_lux ?? 0),
      },
      meta,
    }
  }

  if (eventName === 'name_expired') {
    return {
      event: {
        type: 'name_expired',
        node: bytesToHex(event.node),
        label: event.label,
        actor: bytesToHex(event.actor),
        owner: bytesToHex(event.owner),
        expiresAt: lifecycleValueToIso(event.expires_at, observedAt, targetBlockSeconds),
        graceEndsAt: lifecycleValueToIso(event.grace_ends_at, observedAt, targetBlockSeconds),
        expiresAtBlockHeight: numberOrNull(event.expires_at),
        graceEndsAtBlockHeight: numberOrNull(event.grace_ends_at),
        observedAt: lifecycleValueToIso(event.observed_at, observedAt, targetBlockSeconds),
      },
      meta,
    }
  }

  if (eventName === 'name_released') {
    return {
      event: {
        type: 'name_released',
        node: bytesToHex(event.node),
        label: event.label,
        actor: bytesToHex(event.actor),
        previousOwner: bytesToHex(event.previous_owner),
        releasedAt: lifecycleValueToIso(event.released_at, observedAt, targetBlockSeconds),
      },
      meta,
    }
  }

  if (eventName === 'name_owner_changed') {
    return {
      event: {
        type: 'name_owner_changed',
        node: bytesToHex(event.node),
        actor: bytesToHex(event.actor),
        previousOwner: bytesToHex(event.previous_owner),
        owner: bytesToHex(event.owner),
        manager: bytesToHex(event.manager),
        resolver: bytesToHex(event.resolver),
        expiresAt: lifecycleValueToIso(event.expires_at, observedAt, targetBlockSeconds),
        expiresAtBlockHeight: numberOrNull(event.expires_at),
      },
      meta,
    }
  }

  if (eventName === 'resolver_changed') {
    return {
      event: {
        type: 'resolver_changed',
        node: bytesToHex(event.node),
        actor: bytesToHex(event.actor),
        resolver: bytesToHex(event.resolver),
      },
      meta,
    }
  }

  if (eventName === 'subname_created') {
    return {
      event: {
        type: 'subname_created',
        parentNode: bytesToHex(event.parent_node),
        node: bytesToHex(event.node),
        parentName: event.parent_name,
        name: event.name,
        label: event.label,
        actor: bytesToHex(event.actor),
        owner: bytesToHex(event.owner),
        manager: bytesToHex(event.manager),
        resolver: bytesToHex(event.resolver),
        expiresAt: lifecycleValueToIso(event.expires_at, observedAt, targetBlockSeconds),
        parentExpiresAt: lifecycleValueToIso(event.parent_expires_at, observedAt, targetBlockSeconds),
        expiresAtBlockHeight: numberOrNull(event.expires_at),
        parentExpiresAtBlockHeight: numberOrNull(event.parent_expires_at),
        expiryPolicy: enumValue(event.expiry_policy) === 'FixedBeforeParent' ? 'fixed_before_parent' : 'inherits_parent',
        revocationPolicy: enumValue(event.revocation_policy) === 'Locked' ? 'locked' : 'parent_revocable',
        createdAt: lifecycleValueToIso(event.created_at, observedAt, targetBlockSeconds),
      },
      meta,
    }
  }

  if (eventName === 'subname_delegated') {
    return {
      event: {
        type: 'subname_delegated',
        parentNode: bytesToHex(event.parent_node),
        node: bytesToHex(event.node),
        name: event.name,
        actor: bytesToHex(event.actor),
        manager: bytesToHex(event.manager),
        delegatedAt: lifecycleValueToIso(event.delegated_at, observedAt, targetBlockSeconds),
      },
      meta,
    }
  }

  if (eventName === 'subname_revoked') {
    return {
      event: {
        type: 'subname_revoked',
        parentNode: bytesToHex(event.parent_node),
        node: bytesToHex(event.node),
        name: event.name,
        actor: bytesToHex(event.actor),
        revokedAt: lifecycleValueToIso(event.revoked_at, observedAt, targetBlockSeconds),
      },
      meta,
    }
  }

  if (eventName === 'record_changed') {
    return {
      event: {
        type: 'record_changed',
        node: bytesToHex(event.node),
        controller: bytesToHex(event.controller),
        record: {
          key: event.record?.key,
          value: recordValueFromEvent(event.record?.key, event.record?.value),
          visibility: event.record?.key === 'phoenix_payment_endpoint' ? 'sensitive_public' : 'public',
          updatedAt: lifecycleValueToIso(event.record?.updated_at, observedAt, targetBlockSeconds),
          updatedAtBlockHeight: numberOrNull(event.record?.updated_at),
          ttlSeconds: Number(event.record?.ttl_seconds ?? 300),
        },
      },
      meta,
    }
  }

  if (eventName === 'record_cleared') {
    return {
      event: {
        type: 'record_cleared',
        node: bytesToHex(event.node),
        controller: bytesToHex(event.controller),
        key: event.key,
      },
      meta,
    }
  }

  if (eventName === 'primary_name_changed') {
    return {
      event: {
        type: 'primary_name_changed',
        endpoint: {
          type: endpointKindToRecordKey(event.endpoint?.kind),
          value: endpointValueFromEvent(event.endpoint?.kind, event.endpoint?.value),
        },
        controller: bytesToHex(event.controller),
        node: bytesToHex(event.node),
        name: event.name,
        previousName: event.previous_name ?? null,
        updatedAt: lifecycleValueToIso(event.updated_at, observedAt, targetBlockSeconds),
        updatedAtBlockHeight: numberOrNull(event.updated_at),
      },
      meta,
    }
  }

  if (eventName === 'core_referral_config_changed') {
    return {
      event: {
        type: 'core_referral_config_changed',
        operator: principalFromEvent(event.operator, event.operator_authority),
        previousReferralRewardBps: Number(event.previous_referral_reward_bps ?? 0),
        referralRewardBps: Number(event.referral_reward_bps ?? 0),
      },
      meta,
    }
  }

  if (eventName === 'fee_config_updated') {
    return {
      event: {
        type: 'fee_config_updated',
        operator: principalFromEvent(event.operator, event.operator_authority),
        previousConfig: feeConfigFromEvent(event.previous_config),
        config: feeConfigFromEvent(event.config),
      },
      meta,
    }
  }

  if (eventName === 'treasury_initialized') {
    return {
      event: {
        type: 'treasury_initialized',
        operator: principalFromEvent(event.operator, event.operator_authority),
        operatorRecipient: bytesToBase58(event.operator_recipient),
        allowedFeeSources: (event.allowed_fee_sources ?? []).map(bytesToHex),
      },
      meta,
    }
  }

  if (eventName === 'treasury_operator_changed') {
    return {
      event: {
        type: 'treasury_operator_changed',
        previousOperator: principalFromEvent(event.previous_operator, event.previous_operator_authority),
        operator: principalFromEvent(event.operator, event.operator_authority),
        operatorRecipient: bytesToBase58(event.operator_recipient),
      },
      meta,
    }
  }

  if (eventName === 'treasury_fee_received') {
    return {
      event: {
        type: 'treasury_fee_received',
        sourceContract: bytesToHex(event.source_contract),
        reason: treasuryReasonName(event.reason),
        node: bytesToHex(event.node),
        amountLux: Number(event.amount_lux ?? 0),
        totalReceivedLux: Number(event.total_received_lux ?? 0),
        availableLux: Number(event.available_lux ?? 0),
        registrationReceivedLux: Number(event.registration_received_lux ?? 0),
        renewalReceivedLux: Number(event.renewal_received_lux ?? 0),
        otherReceivedLux: Number(event.other_received_lux ?? 0),
      },
      meta,
    }
  }

  if (eventName === 'treasury_claimed') {
    return {
      event: {
        type: 'treasury_claimed',
        operator: principalFromEvent(event.operator, event.operator_authority),
        operatorRecipient: bytesToBase58(event.operator_recipient),
        amountLux: Number(event.amount_lux ?? 0),
        remainingLux: Number(event.remaining_lux ?? 0),
      },
      meta,
    }
  }

  if (eventName === 'referral_reward_accrued') {
    return {
      event: {
        type: 'referral_reward_accrued',
        referrer: principalFromEvent(event.referrer, event.referrer_authority),
        buyer: principalFromEvent(event.buyer, event.buyer_authority),
        node: bytesToHex(event.node),
        amountLux: Number(event.amount_lux ?? 0),
        claimableLux: Number(event.claimable_lux ?? 0),
        claimedLux: Number(event.claimed_lux ?? 0),
        referralCount: Number(event.referral_count ?? 0),
      },
      meta,
    }
  }

  if (eventName === 'referral_reward_claimed') {
    return {
      event: {
        type: 'referral_reward_claimed',
        referrer: principalFromEvent(event.referrer, event.referrer_authority),
        recipient: bytesToBase58(event.referrer_recipient),
        amountLux: Number(event.amount_lux ?? 0),
        remainingLux: Number(event.remaining_lux ?? 0),
        claimedLux: Number(event.claimed_lux ?? 0),
        referralCount: Number(event.referral_count ?? 0),
      },
      meta,
    }
  }

  return null
}

function recordValueFromEvent(key, value) {
  return key === 'moonlight_address' ? bytesToBase58(value) : bytesToUtf8(value)
}

function endpointValueFromEvent(kind, value) {
  return endpointKindToRecordKey(kind) === 'moonlight_address' ? bytesToBase58(value) : bytesToUtf8(value)
}
