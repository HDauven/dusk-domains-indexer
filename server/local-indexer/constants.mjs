export const RESERVED_LABELS = new Set([
  'dusk',
  'rusk',
  'wallet',
  'webwallet',
  'bridge',
  'explorer',
  'docs',
  'staking',
  'faucet',
  'grants',
  'citadel',
  'foundation',
  'npex',
  'trade',
  'exchange',
  'support',
  'security',
])

export const RESERVED_REASONS = {
  dusk: 'Protocol root name reserved for Dusk-controlled infrastructure.',
  rusk: 'Protocol implementation name reserved to prevent impersonation.',
  wallet: 'Official wallet namespace reserved before public registration.',
  webwallet: 'Official web wallet namespace reserved before public registration.',
  bridge: 'Official bridge namespace reserved before public registration.',
  explorer: 'Official explorer namespace reserved before public registration.',
  docs: 'Official documentation namespace reserved before public registration.',
  staking: 'Staking namespace reserved for official ecosystem use.',
  faucet: 'Faucet namespace reserved for official ecosystem use.',
  grants: 'Grants namespace reserved for official ecosystem use.',
  citadel: 'Citadel namespace reserved for future official identity-related use.',
  foundation: 'Foundation namespace reserved to prevent false affiliation.',
  npex: 'Known partner/venue namespace reserved pending verification policy.',
  trade: 'Market infrastructure namespace reserved pending verification policy.',
  exchange: 'Exchange-related namespace reserved to reduce user confusion.',
  support: 'Support namespace reserved to reduce phishing and fake helpdesk risk.',
  security: 'Security namespace reserved to reduce phishing and incident-response impersonation.',
}

export const RECENT_CHANGE_WARNING_WINDOW_SECONDS = 3 * 24 * 60 * 60

export const HIGH_RISK_RECORD_KEYS = new Set([
  'moonlight_address',
  'phoenix_payment_endpoint',
  'dusk_contract',
  'dusk_asset',
  'evm_address',
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
export const LOCAL_INDEXER_SCHEMA_VERSION = 1
export const LUX_PER_DUSK = 1_000_000_000

export const DEFAULT_FEE_CONFIG = {
  threeCharYearLux: 150 * LUX_PER_DUSK,
  fourCharYearLux: 50 * LUX_PER_DUSK,
  fivePlusYearLux: 10 * LUX_PER_DUSK,
  referralRewardBps: 2_000,
  renewalReferralRewardBps: 1_000,
  premiumReferralRewardBps: 0,
  version: 1,
  updatedAt: 0,
  operator: null,
  txId: null,
  blockHeight: null,
}

