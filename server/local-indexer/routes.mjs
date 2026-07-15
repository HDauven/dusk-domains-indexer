import { DEFAULT_FEE_CONFIG } from './constants.mjs'
import { emptyTreasuryState, referralStateFor } from './economics.mjs'
import { healthResponseForStore } from './health.mjs'
import {
  endpointKey,
  reverseResponse,
} from './naming.mjs'
import {
  activeSubnamesForParent,
  listRecordsForNode,
  listNames,
  liveSubnameForNode,
  recordForNode,
  recordHistoryForNode,
  resolveForward,
  searchName,
  subnameLifecycleForNode,
} from './read-models.mjs'
import {
  LOCAL_INDEXER_ROUTES,
  routeParameters,
  sendJson,
} from './http.mjs'
import { emptyMarketplaceConfig, marketplaceOfferKey, marketplaceOrderIsEscrowed } from './projectors/marketplace.mjs'

export function createLocalIndexerHandler(storeProvider, options = {}) {
  return (request, response) => {
    void handleRequest(storeProvider, request, response, options)
  }
}

async function handleRequest(storeProvider, request, response, options) {
  const reply = (status, body, headers = {}) => sendJson(response, status, body, headers, options)

  try {
    if (request.method === 'OPTIONS') {
      reply(204, null)
      return
    }

    if (request.method !== 'GET') {
      reply(405, { error: 'method_not_allowed' })
      return
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (!LOCAL_INDEXER_ROUTES.has(pathname)) {
      reply(404, { error: 'not_found' })
      return
    }

    const routeParams = routeParameters(pathname, url)
    if (routeParams.error) {
      reply(400, routeParams.error)
      return
    }

    const store = await resolveStore(storeProvider)

    if (pathname === '/health') {
      reply(200, healthResponseForStore(store))
      return
    }

    if (pathname === '/commitment') {
      reply(200, store.commitmentsById?.get(routeParams.commitment) ?? null)
      return
    }

    if (pathname === '/search') {
      const result = searchName(store, url.searchParams.get('query') ?? '')
      reply(200, result)
      return
    }

    if (pathname === '/names') {
      reply(200, listNames(store, url.searchParams.get('owner')))
      return
    }

    if (pathname === '/resolve') {
      const name = url.searchParams.get('name') ?? ''
      const body = resolveForward(store, name)
      reply(body.errors.some((error) => error.code === 'missing_name') ? 400 : 200, body, {
        'cache-control': `public, max-age=${body.cache.ttlSeconds}`,
      })
      return
    }

    if (pathname === '/name') {
      const node = routeParams.node
      reply(200, store.namesByNode.get(node) ?? subnameLifecycleForNode(store, node) ?? null)
      return
    }

    if (pathname === '/records') {
      reply(200, listRecordsForNode(store, routeParams.node))
      return
    }

    if (pathname === '/record') {
      reply(200, recordForNode(store, routeParams.node, routeParams.key))
      return
    }

    if (pathname === '/record-history') {
      reply(200, recordHistoryForNode(store, routeParams.node, routeParams.key))
      return
    }

    if (pathname === '/activity') {
      reply(200, store.activityByNode.get(routeParams.node) ?? [])
      return
    }

    if (pathname === '/reverse') {
      const reverse = store.reverseByEndpoint.get(endpointKey(routeParams.endpoint))
      reply(200, reverse ? reverseResponse(reverse) : null)
      return
    }

    if (pathname === '/subnames') {
      reply(200, activeSubnamesForParent(store, routeParams.parentNode))
      return
    }

    if (pathname === '/subname') {
      reply(200, liveSubnameForNode(store, routeParams.node))
      return
    }

    if (pathname === '/treasury') {
      reply(200, store.treasuryState ?? emptyTreasuryState())
      return
    }

    if (pathname === '/referrals') {
      const referrer = url.searchParams.get('referrer')?.trim() || null
      reply(200, referralStateFor(store, referrer))
      return
    }

    if (pathname === '/fee-config') {
      reply(200, store.feeConfig ?? DEFAULT_FEE_CONFIG)
      return
    }

    if (pathname === '/marketplace/config') {
      reply(200, store.marketplaceConfig ?? emptyMarketplaceConfig())
      return
    }

    if (pathname === '/marketplace/fixed-sales') {
      reply(200, [...(store.marketplaceFixedSalesByNode?.values?.() ?? [])].map((sale) => (
        marketplaceOrderForResponse(store, sale)
      )))
      return
    }

    if (pathname === '/marketplace/fixed-sale') {
      reply(200, marketplaceOrderForResponse(store, store.marketplaceFixedSalesByNode?.get(routeParams.node) ?? null))
      return
    }

    if (pathname === '/marketplace/auctions') {
      reply(200, [...(store.marketplaceAuctionsByNode?.values?.() ?? [])].map((auction) => (
        marketplaceOrderForResponse(store, auction)
      )))
      return
    }

    if (pathname === '/marketplace/auction') {
      reply(200, marketplaceOrderForResponse(store, store.marketplaceAuctionsByNode?.get(routeParams.node) ?? null))
      return
    }

    if (pathname === '/marketplace/offers') {
      const offers = [...(store.marketplaceOffersByKey?.values?.() ?? [])].filter((offer) => (
        (!routeParams.node || offer.node === routeParams.node)
        && (!routeParams.buyerAuthority || offer.buyerAuthority === routeParams.buyerAuthority)
      ))
      reply(200, offers)
      return
    }

    if (pathname === '/marketplace/offer') {
      reply(200, store.marketplaceOffersByKey?.get(marketplaceOfferKey(routeParams.node, routeParams.buyerAuthority)) ?? null)
      return
    }

    if (pathname === '/marketplace/refund') {
      reply(200, store.marketplaceRefundsByAuthority?.get(routeParams.authority) ?? null)
      return
    }

    reply(404, { error: 'not_found' })
  } catch (error) {
    reply(500, {
      error: 'local_indexer_error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function resolveStore(storeProvider) {
  if (typeof storeProvider === 'function') return storeProvider()
  return storeProvider
}

function marketplaceOrderForResponse(store, order) {
  if (!order) return null
  const node = routeOrderNode(order.node)
  const marketplaceContractId = normalizedHex(order.marketplaceContractId)
  return {
    ...order,
    node,
    marketplaceContractId,
    escrowed: marketplaceOrderIsEscrowed(store.namesByNode?.get(node), marketplaceContractId),
  }
}

function routeOrderNode(value) {
  return typeof value === 'string' ? (value.startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`) : ''
}

function normalizedHex(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  return `0x${stripHexPrefix(value)}`
}

function stripHexPrefix(value) {
  return String(value).trim().toLowerCase().replace(/^0x/, '')
}
