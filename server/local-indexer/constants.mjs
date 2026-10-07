import { RESERVED_LABELS as labels, launchPolicyConfig } from '@duskdomains/sdk'
export const RESERVED_LABELS = new Set(labels)
export const RESERVED_REASONS = Object.fromEntries(labels.map(label => [label, 'Reserved by the registration policy.']))
export const LUX_PER_DUSK = 1_000_000_000
const launch = launchPolicyConfig()
export const DEFAULT_FEE_CONFIG = { threeCharYearLux: launch.annual_lux[2], fourCharYearLux: launch.annual_lux[3],
  fivePlusYearLux: launch.annual_lux[4], premiumStartLux: launch.premium_start_lux, referralRewardBps: 2000, renewalReferralRewardBps: 1000, premiumReferralRewardBps: 0, version: 1 }

export const RECENT_CHANGE_WARNING_WINDOW_SECONDS = 3 * 24 * 60 * 60

export const HIGH_RISK_RECORD_KEYS = new Set([
  'moonlight_address',
  'phoenix_payment_endpoint',
  'dusk_contract',
  'dusk_asset',
  'evm_address',
  'address.btc',
  'address.eth',
  'address.sol',
  'address.evm',
  'website',
  'compliance_ref',
])

export const RECORD_VISIBILITIES = new Set(['public', 'sensitive_public'])

export const SUPPORTED_ENDPOINT_TYPES = new Set([
  'moonlight_address',
  'phoenix_payment_endpoint',
  'dusk_contract',
  'dusk_asset',
  'evm_address',
])

export const PUBLIC_PRIMARY_ENDPOINT_TYPES = new Set(['moonlight_address'])
export const LOCAL_INDEXER_API_VERSION = 'v1'
export const LOCAL_INDEXER_SCHEMA_VERSION = 1
export const LOCAL_INDEXER_EVENT_SCHEMA_VERSION = '1'
export const LOCAL_INDEXER_READ_MODEL_SCHEMA_VERSION = 2
export const LOCAL_INDEXER_SQLITE_SCHEMA_VERSION = 1
