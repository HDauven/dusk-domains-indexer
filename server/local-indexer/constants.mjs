export { RESERVED_LABELS, RESERVED_REASONS, DEFAULT_FEE_CONFIG, LUX_PER_DUSK } from '@duskdomains/sdk/projection'

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
export const LOCAL_INDEXER_READ_MODEL_SCHEMA_VERSION = 1
export const LOCAL_INDEXER_SQLITE_SCHEMA_VERSION = 1
