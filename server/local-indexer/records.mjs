import {
  HIGH_RISK_RECORD_KEYS,
  RECENT_CHANGE_WARNING_WINDOW_SECONDS,
  RECORD_VISIBILITIES,
} from './constants.mjs'

const utf8 = new TextEncoder()

export function createRecentChangeWarnings(activity, now, windowSeconds = RECENT_CHANGE_WARNING_WINDOW_SECONDS) {
  return activity
    .map((entry) => warningFromActivityEntry(entry, now, windowSeconds))
    .filter(Boolean)
    .sort((left, right) => left.ageSeconds - right.ageSeconds)
}

export function validateResolverRecords(records) {
  return records.flatMap((record) => {
    if (!record || typeof record !== 'object') {
      return [{ code: 'invalid_record', message: 'Resolver record is malformed.' }]
    }

    const key = String(record.key ?? '')
    const value = String(record.value ?? '')
    const errors = validateRecordValue(key, value)

    if (record.visibility !== undefined && !RECORD_VISIBILITIES.has(record.visibility)) {
      errors.push('Resolver record visibility is unsupported.')
    }
    if (record.ttlSeconds !== undefined && (!Number.isFinite(Number(record.ttlSeconds)) || Number(record.ttlSeconds) < 0)) {
      errors.push('Resolver record TTL must be a non-negative number.')
    }

    return errors.map((message) => ({
      code: 'invalid_record',
      message: `${key || 'record'}: ${message}`,
    }))
  })
}

function warningFromActivityEntry(entry, now, windowSeconds) {
  const timestampMs = new Date(entry?.timestamp ?? '').getTime()
  if (!Number.isFinite(timestampMs)) return null

  const ageSeconds = Math.max(0, Math.floor((now.getTime() - timestampMs) / 1000))
  if (ageSeconds > windowSeconds) return null

  if (entry.eventType === 'resolver_change') {
    return createRecentWarning(entry, {
      code: 'recent_resolver_change',
      severity: 'danger',
      ageSeconds,
      windowSeconds,
      message: 'Resolver changed recently. Refresh records and inspect the resolved endpoint before using this name.',
    })
  }

  if (entry.eventType === 'primary_name') {
    return createRecentWarning(entry, {
      code: 'recent_primary_name_change',
      severity: 'warning',
      ageSeconds,
      windowSeconds,
      message: 'Primary name changed recently. Verify the forward/reverse match before display or transfer.',
    })
  }

  if (entry.eventType === 'record_update' && isHighRiskRecordTarget(entry.target)) {
    return createRecentWarning(entry, {
      code: 'recent_high_risk_record_change',
      severity: 'warning',
      ageSeconds,
      windowSeconds,
      message: `${entry.target} changed recently. Inspect the resolved value before using this name.`,
    })
  }

  return null
}

function createRecentWarning(entry, warning) {
  return {
    code: warning.code,
    severity: warning.severity,
    eventType: entry.eventType,
    node: entry.node,
    name: entry.name,
    actor: entry.actor,
    target: entry.target ?? null,
    timestamp: entry.timestamp,
    ...(entry.txId ? { txId: entry.txId } : {}),
    blockHeight: entry.blockHeight ?? null,
    ageSeconds: warning.ageSeconds,
    windowSeconds: warning.windowSeconds,
    message: warning.message,
  }
}

function isHighRiskRecordTarget(target) {
  if (!target) return false
  if (String(target).startsWith('service_endpoint.')) return true
  return HIGH_RISK_RECORD_KEYS.has(target)
}

function validateRecordValue(key, value) {
  const definition = recordDefinition(key)
  if (!definition) return [`Unsupported resolver record key: ${key}`]

  return [
    ...validateByteLength(value, definition.maxBytes),
    ...definition.validate(value),
  ]
}

function recordDefinition(key) {
  const staticDefinitions = {
    moonlight_address: { maxBytes: 160, validate: validateMoonlightAddress },
    phoenix_payment_endpoint: { maxBytes: 256, validate: validatePhoenixPaymentEndpoint },
    dusk_contract: { maxBytes: 66, validate: validateDuskContract },
    dusk_asset: { maxBytes: 128, validate: validateOpaqueIdentifier },
    evm_address: { maxBytes: 42, validate: validateEvmAddress },
    website: { maxBytes: 2048, validate: validateHttpsUrl },
    avatar: { maxBytes: 2048, validate: validateDisplayUri },
    content_pointer: { maxBytes: 2048, validate: validateContentPointer },
    attestation_ref: { maxBytes: 512, validate: validateOpaqueReference },
    compliance_ref: { maxBytes: 512, validate: validateComplianceReference },
  }
  if (staticDefinitions[key]) return staticDefinitions[key]
  if (/^text\.[a-z0-9_:-]{1,40}$/.test(key)) return { maxBytes: 512, validate: validatePublicText }
  if (/^service_endpoint\.[a-z0-9_-]{1,40}$/.test(key)) return { maxBytes: 2048, validate: validateHttpsUrl }
  return null
}

function validateByteLength(value, maxBytes) {
  if (utf8.encode(value).byteLength > maxBytes) return [`Value exceeds ${maxBytes} bytes.`]
  return []
}

function validateMoonlightAddress(value) {
  if (/^dusk1[a-z0-9]{20,127}$/.test(value)) return []
  if (/^[1-9A-HJ-NP-Za-km-z]{32,160}$/.test(value)) return []
  return ['Moonlight addresses must use a dusk1-prefixed address or Dusk account address form.']
}

function validatePhoenixPaymentEndpoint(value) {
  if (/^[A-Za-z0-9:_-]{32,256}$/.test(value)) return []
  return ['Phoenix payment endpoints must be explicit opaque payment endpoints, not profile identity fields.']
}

function validateDuskContract(value) {
  if (/^0x[a-fA-F0-9]{64}$/.test(value)) return []
  return ['Dusk contract IDs must be 32-byte hex strings formatted as 0x + 64 hex characters.']
}

function validateEvmAddress(value) {
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) return []
  return ['EVM addresses must be 20-byte hex strings formatted as 0x + 40 hex characters.']
}

function validateHttpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? [] : ['URLs must use HTTPS.']
  } catch {
    return ['Value must be a valid HTTPS URL.']
  }
}

function validateDisplayUri(value) {
  if (value.startsWith('ipfs://') || value.startsWith('ar://')) return []
  return validateHttpsUrl(value)
}

function validateContentPointer(value) {
  if (/^ipfs:\/\/[a-zA-Z0-9]+/.test(value) || /^bafy[a-zA-Z0-9]+$/.test(value)) return []
  return validateDisplayUri(value)
}

function validateOpaqueIdentifier(value) {
  if (/^[A-Za-z0-9:._-]{3,128}$/.test(value)) return []
  return ['Identifier must be 3-128 visible characters using letters, numbers, colon, dot, underscore, or hyphen.']
}

function validateOpaqueReference(value) {
  if (/^(https:\/\/|urn:|dusk:)[^\s]{3,512}$/.test(value)) return []
  return ['Reference must be an HTTPS URL, URN, or dusk: reference without whitespace.']
}

function validateComplianceReference(value) {
  return validateOpaqueReference(value)
}

function validatePublicText(value) {
  if (/[\u0000-\u001F\u007F]/u.test(value)) return ['Text records cannot contain control characters.']
  return []
}
