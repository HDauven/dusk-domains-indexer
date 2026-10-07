// HTTP/snapshot presentation helpers. Contract semantics live in SDK projection.
import { DEFAULT_FEE_CONFIG } from './constants.mjs'
export const recordIndexKey = (node, key) => `${node}:${key}`
export const commitmentKey = (controller, commitment) => `${controller}:${commitment}`
export const marketplaceOfferKey = (node, buyer) => `${node}:${buyer}`
export const emptyPoolState = () => ({ registrationsPaused: false })
export const emptyMarketplaceConfig = () => ({ initialized: false, tradingPaused: false, feeBps: 250 })
export const emptyTreasuryState = () => ({ initialized: false, protocolAccruedLux: '0', referralLiabilityLux: '0', accountedLux: '0', events: [] })
export const normalizeFeeConfig = value => ({ ...DEFAULT_FEE_CONFIG, ...value })
export const normalizeTreasuryState = value => ({ ...emptyTreasuryState(), ...value })
export const normalizeReferralStateMap = value => new Map(Array.isArray(value) ? value.map(v => [v.referrer, v]) : Object.entries(value ?? {}))
export const referralStateFor = (store, referrer) => ({
  supported: Boolean(store.referralRewardsSupported), referrer, claimableLux: '0', accruedLux: '0', claimedLux: '0', referralCount: 0, recentActivity: [], events: [], ...store.referralsByReferrer?.get(referrer),
})
export function marketplaceOrderIsEscrowed(name, market) {
  return Boolean(name?.custody && name.custody.custodian === market)
}
export function collectSnapshotControllers(name) {
  return new Set([name.owner, name.manager, ...(name.controllers ?? []), ...(name.activity ?? []).map(a => a.actor)].filter(Boolean))
}
export function rebuildCurrentRecordIndexes(records) {
  return new Map([...records].flatMap(([node, rows]) => rows.map(row => [recordIndexKey(node, row.key), row])))
}
export function appendRecordHistory({ recordHistoryByNode, recordHistoryByNodeKey, node, entry }, row) {
  entry ??= row
  node ??= entry.node
  for (const [map, key] of [[recordHistoryByNode, node], [recordHistoryByNodeKey, recordIndexKey(node, entry.key)]]) {
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(entry)
  }
}
export function assertSafeNumericTree(value, label = 'value') {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error(`Unsafe numeric ${label}`)
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) assertSafeNumericTree(child, `${label}.${key}`)
}
