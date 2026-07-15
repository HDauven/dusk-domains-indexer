import { activityEntry } from '../activity.mjs'
import { normalizeNode } from '../http.mjs'
import { assertSafeNumericTree, checkedSafeSum, safeNonNegativeInteger } from '../safe-numbers.mjs'

export function applyMarketplaceEvent(store, event, meta, fallbackTimestamp) {
  assertSafeNumericTree(event, 'marketplace event')
  assertSafeNumericTree(meta, 'marketplace event metadata')
  if (event.type === 'marketplace_initialized') {
    store.marketplaceConfig = {
      initialized: true,
      coreContract: normalizedHex(event.coreContract),
      treasuryContract: normalizedHex(event.treasuryContract),
      marketplaceAuthority: normalizedHex(event.marketplaceAuthority),
      operator: normalizedHex(event.operator),
      feeBps: Number(event.feeBps ?? 0),
      updatedAtBlockHeight: meta.blockHeight ?? null,
      txId: meta.txId ?? null,
      blockHeight: meta.blockHeight ?? null,
    }
    return
  }

  if (event.type === 'marketplace_config_updated') {
    store.marketplaceConfig = {
      ...emptyMarketplaceConfig(),
      ...store.marketplaceConfig,
      initialized: true,
      operator: normalizedHex(event.operator),
      feeBps: Number(event.feeBps ?? 0),
      updatedAtBlockHeight: numberOrNull(event.updatedAtBlockHeight),
      txId: meta.txId ?? null,
      blockHeight: meta.blockHeight ?? null,
    }
    return
  }

  if (event.type === 'marketplace_refund_claimed') {
    store.marketplaceRefundsByAuthority.delete(normalizedHex(event.authority))
    return
  }

  const node = normalizeNode(event.node)
  const name = event.name
    ?? store.marketplaceFixedSalesByNode.get(node)?.name
    ?? store.marketplaceAuctionsByNode.get(node)?.name
    ?? store.namesByNode.get(node)?.canonicalName
    ?? node
  store.activityByNode.set(node, [
    activityEntry({
      eventType: event.type,
      node,
      name,
      actor: marketplaceActor(event),
      target: marketplaceTarget(event),
      timestamp: fallbackTimestamp,
      meta,
    }),
    ...(store.activityByNode.get(node) ?? []),
  ])

  if (event.type === 'domain_fixed_sale_opened') {
    const marketplaceContractId = normalizedHex(meta.contractId)
    store.marketplaceFixedSalesByNode.set(node, {
      node,
      name: event.name,
      sellerAuthority: normalizedHex(event.sellerAuthority),
      priceLux: Number(event.priceLux ?? 0),
      privateBuyer: normalizedHex(event.privateBuyer),
      feeBps: Number(event.feeBps ?? 0),
      expiresAtBlockHeight: Number(event.expiresAtBlockHeight ?? 0),
      openedAtBlockHeight: Number(event.openedAtBlockHeight ?? 0),
      marketplaceContractId,
      escrowed: marketplaceOrderIsEscrowed(store.namesByNode.get(node), marketplaceContractId),
      txId: meta.txId ?? null,
      blockHeight: meta.blockHeight ?? null,
      lastEventType: event.type,
    })
    return
  }

  if (event.type === 'domain_fixed_sale_closed' || event.type === 'domain_fixed_sale_filled') {
    store.marketplaceFixedSalesByNode.delete(node)
    return
  }

  if (event.type === 'domain_auction_created') {
    const marketplaceContractId = normalizedHex(meta.contractId)
    store.marketplaceAuctionsByNode.set(node, {
      node,
      name: event.name,
      sellerAuthority: normalizedHex(event.sellerAuthority),
      reservePriceLux: Number(event.reservePriceLux ?? 0),
      durationBlocks: Number(event.durationBlocks ?? 0),
      startDeadlineBlockHeight: Number(event.startDeadlineBlockHeight ?? 0),
      feeBps: Number(event.feeBps ?? 0),
      startBlockHeight: null,
      endBlockHeight: null,
      highestBid: null,
      bidCount: 0,
      createdAtBlockHeight: Number(event.createdAtBlockHeight ?? 0),
      marketplaceContractId,
      escrowed: marketplaceOrderIsEscrowed(store.namesByNode.get(node), marketplaceContractId),
      txId: meta.txId ?? null,
      blockHeight: meta.blockHeight ?? null,
      lastEventType: event.type,
    })
    return
  }

  if (event.type === 'domain_bid_placed') {
    const current = store.marketplaceAuctionsByNode.get(node)
    if (!current) return
    if (event.previousBidderAuthority && Number(event.previousBidLux ?? 0) > 0) {
      creditRefund(store, event.previousBidderAuthority, Number(event.previousBidLux), event.type, meta)
    }
    store.marketplaceAuctionsByNode.set(node, {
      ...current,
      startBlockHeight: Number(event.startBlock ?? 0),
      endBlockHeight: Number(event.endBlock ?? 0),
      highestBid: {
        bidderAuthority: normalizedHex(event.bidderAuthority),
        amountLux: Number(event.amountLux ?? 0),
        placedAtBlockHeight: Number(event.placedAtBlockHeight ?? 0),
      },
      bidCount: Number(event.bidCount ?? 0),
      txId: meta.txId ?? null,
      blockHeight: meta.blockHeight ?? null,
      lastEventType: event.type,
    })
    return
  }

  if (event.type === 'domain_auction_cancelled' || event.type === 'domain_auction_settled') {
    const current = store.marketplaceAuctionsByNode.get(node)
    if (event.type === 'domain_auction_settled' && event.domainExpired && current?.highestBid) {
      creditRefund(store, current.highestBid.bidderAuthority, current.highestBid.amountLux, event.type, meta)
    }
    store.marketplaceAuctionsByNode.delete(node)
    return
  }

  const buyerAuthority = normalizedHex(event.buyerAuthority)
  const offerKey = marketplaceOfferKey(node, buyerAuthority)
  if (event.type === 'domain_offer_placed') {
    store.marketplaceOffersByKey.set(offerKey, {
      node,
      name,
      buyerAuthority,
      amountLux: Number(event.amountLux ?? 0),
      feeBps: Number(event.feeBps ?? 0),
      expiresAtBlockHeight: Number(event.expiresAtBlockHeight ?? 0),
      placedAtBlockHeight: Number(event.placedAtBlockHeight ?? 0),
      txId: meta.txId ?? null,
      blockHeight: meta.blockHeight ?? null,
      lastEventType: event.type,
    })
    return
  }

  if (event.type === 'domain_offer_closed') {
    store.marketplaceOffersByKey.delete(offerKey)
    creditRefund(store, buyerAuthority, Number(event.amountLux ?? 0), event.type, meta)
    return
  }

  store.marketplaceOffersByKey.delete(offerKey)
}

export function emptyMarketplaceConfig() {
  return {
    initialized: false,
    coreContract: null,
    treasuryContract: null,
    marketplaceAuthority: null,
    operator: null,
    feeBps: 0,
    updatedAtBlockHeight: null,
    txId: null,
    blockHeight: null,
  }
}

export function marketplaceOfferKey(node, buyerAuthority) {
  return `${normalizeNode(node)}:${normalizedHex(buyerAuthority)}`
}

function creditRefund(store, authorityValue, amountLux, eventType, meta) {
  const authority = normalizedHex(authorityValue)
  const current = store.marketplaceRefundsByAuthority.get(authority)
  const nextAmount = checkedSafeSum(current?.amountLux ?? 0, amountLux, 'marketplace refund balance')
  store.marketplaceRefundsByAuthority.set(authority, {
    authority,
    recipient: current?.recipient ?? null,
    amountLux: nextAmount,
    txId: meta.txId ?? null,
    blockHeight: meta.blockHeight ?? null,
    lastEventType: eventType,
  })
}

function marketplaceActor(event) {
  if (event.type === 'domain_bid_placed') return normalizedHex(event.bidderAuthority)
  if (event.type === 'domain_offer_placed' || event.type === 'domain_offer_closed') {
    return normalizedHex(event.buyerAuthority)
  }
  return normalizedHex(event.sellerAuthority) ?? 'marketplace'
}

function marketplaceTarget(event) {
  if (event.type === 'domain_fixed_sale_opened') return String(event.priceLux ?? 0)
  if (event.type === 'domain_fixed_sale_filled') return String(event.grossAmountLux ?? 0)
  if (event.type === 'domain_auction_created') return String(event.reservePriceLux ?? 0)
  if (event.type === 'domain_bid_placed') return String(event.amountLux ?? 0)
  if (event.type === 'domain_auction_settled') return String(event.grossAmountLux ?? 0)
  if (event.type === 'domain_offer_placed' || event.type === 'domain_offer_closed') return String(event.amountLux ?? 0)
  if (event.type === 'domain_offer_accepted') return String(event.grossAmountLux ?? 0)
  return event.expired ? 'expired' : 'cancelled'
}

export function marketplaceOrderIsEscrowed(name, marketplaceContractId) {
  if (!name || !marketplaceContractId) return false
  return sameHex(name.owner, marketplaceContractId) && sameHex(name.manager, marketplaceContractId)
}

function sameHex(left, right) {
  if (!left || !right) return false
  return stripHexPrefix(left) === stripHexPrefix(right)
}

function normalizedHex(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  return `0x${stripHexPrefix(value)}`
}

function stripHexPrefix(value) {
  return String(value).trim().toLowerCase().replace(/^0x/, '')
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null
  return safeNonNegativeInteger(value, 'marketplace value')
}
