import { readFile } from 'node:fs/promises'
import { normalizeSnapshotBlockCursor } from './checkpoint.mjs'
import { PUBLIC_PRIMARY_ENDPOINT_TYPES } from './constants.mjs'
import {
  normalizeFeeConfig,
  normalizeReferralStateMap,
  normalizeTreasuryState,
} from './economics.mjs'
import { endpointKey } from './naming.mjs'
import {
  appendRecordHistory,
  collectSnapshotControllers,
  rebuildCurrentRecordIndexes,
} from './projectors.mjs'
import {
  indexedLifecycleBlocksRegistration,
  indexedSubnameBlocksRegistration,
} from './read-models.mjs'
import {
  normalizeName,
  normalizeNode,
  numberOrNull,
} from './http.mjs'
import { emptyMarketplaceConfig, marketplaceOfferKey } from './projectors/marketplace.mjs'
import { assertSafeNumericTree } from './safe-numbers.mjs'

export async function loadSnapshotStore(snapshotFile) {
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'))
  assertSafeNumericTree(snapshot, 'snapshot')
  const names = Array.isArray(snapshot.names) ? snapshot.names : []
  const reverse = Array.isArray(snapshot.reverse) ? snapshot.reverse : []
  const subnames = Array.isArray(snapshot.subnames) ? snapshot.subnames : []
  const marketplaceFixedSales = Array.isArray(snapshot.marketplaceFixedSales) ? snapshot.marketplaceFixedSales : []
  const marketplaceAuctions = Array.isArray(snapshot.marketplaceAuctions) ? snapshot.marketplaceAuctions : []
  const marketplaceOffers = Array.isArray(snapshot.marketplaceOffers) ? snapshot.marketplaceOffers : []
  const marketplaceRefunds = Array.isArray(snapshot.marketplaceRefunds) ? snapshot.marketplaceRefunds : []
  const cursor = normalizeSnapshotBlockCursor(snapshot.cursor)
  const checkpoint = normalizeSnapshotBlockCursor(snapshot.checkpoint ?? (
    snapshot.currentBlockHeight === undefined ? null : { lastBlockHeight: snapshot.currentBlockHeight }
  ))
  const now = new Date()
  const namesByCanonical = new Map()
  const namesByNode = new Map()
  const activityByNode = new Map()
  const reverseByEndpoint = new Map()
  const subnamesByNode = new Map()
  const subnamesByParent = new Map()
  const subnamesByCanonical = new Map()
  const recordsByNode = new Map()
  let recordsByNodeKey = new Map()
  const recordHistoryByNode = new Map()
  const recordHistoryByNodeKey = new Map()
  const commitmentsById = new Map()
  const controllersByNode = new Map()
  const marketplaceFixedSalesByNode = new Map()
  const marketplaceAuctionsByNode = new Map()
  const marketplaceOffersByKey = new Map()
  const marketplaceRefundsByAuthority = new Map()
  const marketplaceConfig = {
    ...emptyMarketplaceConfig(),
    ...(snapshot.marketplaceConfig ?? {}),
  }
  const treasuryState = normalizeTreasuryState(snapshot.treasury ?? snapshot.treasuryState)
  const feeConfig = normalizeFeeConfig(snapshot.feeConfig ?? snapshot.fee_config)
  const rawReferralState = snapshot.referrals ?? snapshot.referralState
  const referralsByReferrer = normalizeReferralStateMap(rawReferralState)
  const referralRewardsSupported = Boolean(
    snapshot.referralRewardsSupported
    ?? snapshot.referral_rewards_supported
    ?? treasuryState.initialized
    ?? (referralsByReferrer.size > 0),
  )

  for (const name of names) {
    if (!name?.canonicalName || !name?.node) continue
    const canonicalName = normalizeName(name.canonicalName)
    const node = normalizeNode(name.node)
    const lifecycle = {
      node,
      canonicalName,
      owner: name.owner ?? null,
      manager: name.manager ?? null,
      resolverId: name.resolverId ?? null,
      expiresAt: name.expiresAt ?? null,
      graceEndsAt: name.graceEndsAt ?? null,
      expiresAtBlockHeight: numberOrNull(name.expiresAtBlockHeight),
      graceEndsAtBlockHeight: numberOrNull(name.graceEndsAtBlockHeight),
      status: name.status ?? 'active',
      lastEventType: name.lastEventType ?? 'name_owner_changed',
    }
    if (indexedLifecycleBlocksRegistration(lifecycle, now)) {
      recordsByNode.set(node, Array.isArray(name.records) ? name.records : [])
      namesByCanonical.set(canonicalName, {
        ...name,
        canonicalName,
        node,
        lifecycle,
        records: Array.isArray(name.records) ? name.records : [],
        activity: Array.isArray(name.activity) ? name.activity : [],
      })
    }
    namesByNode.set(node, lifecycle)
    activityByNode.set(node, Array.isArray(name.activity) ? name.activity : [])
    if (indexedLifecycleBlocksRegistration(lifecycle, now)) {
      controllersByNode.set(node, collectSnapshotControllers(name))
    }
  }

  for (const row of reverse) {
    if (!row?.endpoint?.type || !row?.endpoint?.value) continue
    if (!PUBLIC_PRIMARY_ENDPOINT_TYPES.has(row.endpoint.type)) continue
    if (row.node && !indexedLifecycleBlocksRegistration(namesByNode.get(normalizeNode(row.node)), now)) continue
    const primaryName = row.primaryName ?? row.name ?? null
    if (!primaryName) continue
    reverseByEndpoint.set(endpointKey(row.endpoint), {
      ...row,
      primaryName,
      name: primaryName,
    })
  }

  const candidateSubnamesByNode = new Map()
  for (const subname of subnames) {
    if (!subname?.node || !subname?.parentNode) continue
    const node = normalizeNode(subname.node)
    const parentNode = normalizeNode(subname.parentNode)
    const normalized = { ...subname, node, parentNode, canonicalName: normalizeName(subname.name) }
    candidateSubnamesByNode.set(node, normalized)
  }

  const subnameCandidateStore = {
    namesByNode,
    subnamesByNode: candidateSubnamesByNode,
  }
  for (const normalized of candidateSubnamesByNode.values()) {
    if (!indexedSubnameBlocksRegistration(subnameCandidateStore, normalized, now)) continue
    const node = normalizeNode(normalized.node)
    const parentNode = normalizeNode(normalized.parentNode)
    subnamesByNode.set(node, normalized)
    subnamesByCanonical.set(normalizeName(normalized.name), normalized)
    if (Array.isArray(normalized.records)) recordsByNode.set(node, normalized.records)
    subnamesByParent.set(parentNode, [normalized, ...(subnamesByParent.get(parentNode) ?? [])])
    activityByNode.set(node, [
      {
        id: `subname_created:${node}:${normalized.manager}:${normalized.txId ?? normalized.createdAt}`,
        eventType: 'subname_created',
        node,
        name: normalized.name,
        actor: normalized.manager,
        target: normalized.manager,
        timestamp: normalized.createdAt,
        blockHeight: normalized.blockHeight ?? null,
        ...(normalized.txId ? { txId: normalized.txId } : {}),
      },
      ...(activityByNode.get(node) ?? []),
    ])
  }

  recordsByNodeKey = rebuildCurrentRecordIndexes(recordsByNode)

  for (const row of Array.isArray(snapshot.recordHistory) ? snapshot.recordHistory : []) {
    if (!row?.node || !row?.key) continue
    appendRecordHistory({
      recordHistoryByNode,
      recordHistoryByNodeKey,
    }, row)
  }

  for (const sale of marketplaceFixedSales) {
    if (!sale?.node || !sale?.name) continue
    const node = normalizeNode(sale.node)
    marketplaceFixedSalesByNode.set(node, {
      ...sale,
      node,
      sellerAuthority: normalizeNode(sale.sellerAuthority),
      privateBuyer: sale.privateBuyer ? normalizeNode(sale.privateBuyer) : null,
      marketplaceContractId: sale.marketplaceContractId ? normalizeNode(sale.marketplaceContractId) : null,
      priceLux: Number(sale.priceLux ?? 0),
      feeBps: Number(sale.feeBps ?? 0),
      expiresAtBlockHeight: Number(sale.expiresAtBlockHeight ?? 0),
      openedAtBlockHeight: Number(sale.openedAtBlockHeight ?? 0),
      escrowed: Boolean(sale.escrowed),
      blockHeight: numberOrNull(sale.blockHeight),
      txId: sale.txId ?? null,
      lastEventType: 'domain_fixed_sale_opened',
    })
  }

  for (const auction of marketplaceAuctions) {
    if (!auction?.node || !auction?.name) continue
    const node = normalizeNode(auction.node)
    marketplaceAuctionsByNode.set(node, {
      ...auction,
      node,
      marketplaceContractId: typeof auction.marketplaceContractId === 'string' ? normalizeNode(auction.marketplaceContractId) : null,
      escrowed: Boolean(auction.escrowed),
      sellerAuthority: normalizeNode(auction.sellerAuthority),
      reservePriceLux: Number(auction.reservePriceLux ?? 0),
      durationBlocks: Number(auction.durationBlocks ?? 0),
      startDeadlineBlockHeight: Number(auction.startDeadlineBlockHeight ?? 0),
      feeBps: Number(auction.feeBps ?? 0),
      startBlockHeight: numberOrNull(auction.startBlockHeight),
      endBlockHeight: numberOrNull(auction.endBlockHeight),
      highestBid: auction.highestBid ?? null,
      bidCount: Number(auction.bidCount ?? 0),
      createdAtBlockHeight: Number(auction.createdAtBlockHeight ?? 0),
      blockHeight: numberOrNull(auction.blockHeight),
      txId: auction.txId ?? null,
      lastEventType: auction.lastEventType ?? 'domain_auction_created',
    })
  }

  for (const offer of marketplaceOffers) {
    if (!offer?.node || !offer?.buyerAuthority) continue
    const node = normalizeNode(offer.node)
    const buyerAuthority = normalizeNode(offer.buyerAuthority)
    marketplaceOffersByKey.set(marketplaceOfferKey(node, buyerAuthority), {
      ...offer,
      node,
      name: offer.name ?? namesByNode.get(node)?.canonicalName ?? node,
      buyerAuthority,
      amountLux: Number(offer.amountLux ?? 0),
      feeBps: Number(offer.feeBps ?? 0),
      expiresAtBlockHeight: Number(offer.expiresAtBlockHeight ?? 0),
      placedAtBlockHeight: Number(offer.placedAtBlockHeight ?? 0),
      blockHeight: numberOrNull(offer.blockHeight),
      txId: offer.txId ?? null,
      lastEventType: 'domain_offer_placed',
    })
  }

  for (const refund of marketplaceRefunds) {
    if (!refund?.authority) continue
    const authority = normalizeNode(refund.authority)
    marketplaceRefundsByAuthority.set(authority, {
      ...refund,
      authority,
      recipient: refund.recipient ?? null,
      amountLux: Number(refund.amountLux ?? 0),
      blockHeight: numberOrNull(refund.blockHeight),
      txId: refund.txId ?? null,
    })
  }

  return {
    generatedAt: snapshot.generatedAt ?? new Date().toISOString(),
    source: snapshot.source ?? 'local-indexer-snapshot',
    mode: 'snapshot',
    namesByCanonical,
    namesByNode,
    activityByNode,
    reverseByEndpoint,
    subnamesByNode,
    subnamesByParent,
    subnamesByCanonical,
    commitmentsById,
    recordsByNode,
    recordsByNodeKey,
    recordHistoryByNode,
    recordHistoryByNodeKey,
    controllersByNode,
    marketplaceConfig,
    marketplaceFixedSalesByNode,
    marketplaceAuctionsByNode,
    marketplaceOffersByKey,
    marketplaceRefundsByAuthority,
    treasuryState,
    feeConfig,
    referralsByReferrer,
    referralRewardsSupported,
    ...(cursor ? { cursor } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  }
}
