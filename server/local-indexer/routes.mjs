import { premiumForName } from './read-models/premium.mjs'
import { namespaceForNode, namespaceSummary } from './read-models/namespace.mjs'
import { createShareHandler } from './share/routes.mjs'
import { indexNowConfig } from './indexnow.mjs'
import { randomUUID } from 'node:crypto'
import { LIST_FIELDS, listKey, pageParameters, paginate } from './pagination.mjs'
import { namesPage } from './name-authority-index.mjs'
import { corsHeaders, createRateLimiter } from './security.mjs'
import { DEFAULT_FEE_CONFIG } from './constants.mjs'
import {
  emptyTreasuryState,
  referralStateFor,
  commitmentKey,
  emptyMarketplaceConfig,
  marketplaceOfferKey,
  marketplaceOrderIsEscrowed,
} from './view-utils.mjs'
import { createRecentChangeWarnings } from './records.mjs'
import { healthResponseForStore } from './health.mjs'
import { indexedLifecycleBlocksRegistration, indexedNamespaceNodeBlocksRegistration, indexedSubnameBlocksRegistration, lifecycleClock } from './read-models/lifecycle.mjs'
import {
  endpointKey,
  reverseResponse,
} from './naming.mjs'
import {
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
  normalizeName,
  normalizeNode,
  routeParameters,
  sendJson,
} from './http.mjs'

export function createLocalIndexerHandler(storeProvider, options = {}) {
  const rateLimit = createRateLimiter(options)
  const share = createShareHandler()
  const indexNow = options.indexNow ?? indexNowConfig()
  return (request, response) => {
    void handleRequest(storeProvider, request, response, { ...options, rateLimit, share, indexNow })
  }
}

async function handleRequest(storeProvider, request, response, options) {
  const requestId = randomUUID()
  const logger = options.logger ?? console
  const reply = (status, body, headers = {}) => sendJson(response, status, body, {
    ...corsHeaders(options, request), 'x-request-id': requestId, 'cache-control': 'no-store', ...headers,
  })

  try {
    const retryAfter = options.rateLimit(request)
    if (retryAfter) {
      reply(429, { error: 'rate_limited', message: 'Too many requests.' }, { 'retry-after': String(retryAfter) })
      return
    }
    if (request.method === 'OPTIONS') {
      reply(204, null)
      return
    }

    if (request.method !== 'GET') {
      reply(405, { error: 'method_not_allowed', message: 'Use GET or OPTIONS.' })
      return
    }

    let url
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      reply(400, { error: 'invalid_url', message: 'Invalid request URL.' })
      return
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (pathname.startsWith('/indexnow/')) {
      const { enabled, key } = options.indexNow
      if (enabled && url.pathname === `/indexnow/${key}.txt`) {
        response.writeHead(200, {
          ...corsHeaders(options, request), 'x-request-id': requestId,
          'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        response.end(key)
      } else reply(404, { error: 'not_found', message: 'Route not found.' })
      return
    }

    if (await options.share(pathname, () => resolveStore(storeProvider), response, { ...corsHeaders(options, request), 'x-request-id': requestId })) return

    if (!LOCAL_INDEXER_ROUTES.has(pathname)) {
      reply(404, { error: 'not_found', message: 'Route not found.' })
      return
    }

    const routeParams = routeParameters(pathname, url)
    if (routeParams.error) {
      reply(400, routeParams.error)
      return
    }

    const page = pageParameters(pathname, url)
    if (page.error) {
      reply(400, page.error)
      return
    }
    const replyPage = (rows, map = (item) => item) => {
      const result = paginate(rows, page, (item) => listKey(pathname, item))
      reply(200, { [LIST_FIELDS[pathname]]: result.items.map(map), nextCursor: result.nextCursor })
    }
    let store = await resolveStore(storeProvider, pathname === '/health')
    const market = url.searchParams.get('marketplace')
    if (market && pathname.startsWith('/marketplace/')) {
      const id = normalizeNode(market)
      if (!/^0x[0-9a-f]{64}$/.test(id)) { reply(400, { error: 'invalid_marketplace' }); return }
      const orders = (store.marketplaceOrders ?? []).filter(o => o.marketplaceContractId === id)
      store = { ...store,
        marketplaceConfig: store.marketplaceConfigs?.[id] ?? { initialized: false, marketplaceContractId: id, tradingPaused: true, orderApiVersion: 1 },
        marketplaceFixedSalesByNode: new Map(orders.filter(o => o.kind === 'Fixed').map(o => [o.node, o])),
        marketplaceAuctionsByNode: new Map(orders.filter(o => o.kind === 'Auction').map(o => [o.node, o])),
        marketplaceOffersByKey: new Map(orders.filter(o => o.kind === 'Offer').map(o => [marketplaceOfferKey(o.node, o.buyerAuthority), o])),
        marketplaceRefundsByAuthority: new Map((store.marketplaceRefunds ?? []).filter(r => r.marketplaceContractId === id).map(r => [r.authority, r])),
      }
    }

    const orderId = url.searchParams.get('orderId')
    if (pathname.startsWith('/marketplace/') && orderId !== null
      && (!/^[0-9]{1,20}$/.test(orderId) || BigInt(orderId) > 18446744073709551615n || url.searchParams.getAll('orderId').length > 1)) {
      reply(400, { error: 'invalid_order_id' }); return
    }
    const marketOrders = (kind, fallback) => store.frozen
      ? filterRows(store.marketplaceOrders ?? [], o => o.kind === kind && o.marketplaceContractId === store.marketplaceConfig?.marketplaceContractId)
      : fallback?.values() ?? []
    const singularOrder = (kind, fallback) => orderId === null ? fallback : [...marketOrders(kind)].find(o =>
      o.node === routeParams.node && o.orderId === BigInt(orderId).toString()
      && (!routeParams.buyerAuthority || o.buyerAuthority === routeParams.buyerAuthority)) ?? null

    if (pathname === '/health') {
      reply(200, publicHealth(store, page, logger, requestId))
      return
    }

    if (pathname === '/commitment') {
      const commitment = routeParams.controller
        ? store.commitmentsByKey?.get(commitmentKey(routeParams.controller, routeParams.commitment))
        : store.commitmentsById?.get(routeParams.commitment)
      reply(200, commitment ?? null)
      return
    }

    if (pathname === '/search') {
      const result = searchName(store, url.searchParams.get('query') ?? '')
      reply(200, { ...result, nextCursor: null })
      return
    }

    if (pathname === '/names') {
      const result = namesPage(store, url.searchParams.get('owner'), page)
      if (result.error) {
        reply(503, result)
        return
      }
      const names = listNames({ ...store, namesByCanonical: new Map(result.items.map((name) => [name.lifecycle.canonicalName, name])) })
      const byNode = new Map(names.map((name) => [name.node, name]))
      reply(200, { names: result.items.map((name) => byNode.get(name.node)), nextCursor: result.nextCursor })
      return
    }

    if (pathname === '/resolve') {
      const name = url.searchParams.get('name') ?? ''
      const body = publicForward(store, name, page)
      reply(body.errors.some((error) => error.code === 'missing_name') ? 400 : 200, body, {
        'cache-control': `public, max-age=${body.cache.ttlSeconds}`,
      })
      return
    }

    if (pathname === '/name') {
      const node = routeParams.node
      const name = store.namesByNode.get(node) ?? subnameLifecycleForNode(store, node)
      reply(200, name ? { ...name, ...premiumForName(store, name), namespace: namespaceForNode(store, node) } : null)
      return
    }

    if (pathname === '/records') {
      replyPage(listRecordsForNode(store, routeParams.node))
      return
    }

    if (pathname === '/record') {
      reply(200, recordForNode(store, routeParams.node, routeParams.key))
      return
    }

    if (pathname === '/record-history') {
      replyPage(recordHistoryForNode(store, routeParams.node, routeParams.key))
      return
    }

    if (pathname === '/activity') {
      replyPage(store.activityByNode.get(routeParams.node) ?? [])
      return
    }

    if (pathname === '/reverse') {
      const reverse = store.reverseByEndpoint.get(endpointKey(routeParams.endpoint))
      const primaryName = normalizeName(reverse?.primaryName ?? reverse?.name)
      const node = normalizeNode(reverse?.node
        ?? store.subnamesByCanonical?.get(primaryName)?.node
        ?? store.namesByCanonical.get(primaryName)?.node)
      reply(200, reverse && indexedNamespaceNodeBlocksRegistration(store, node, lifecycleClock(store)) ? reverseResponse(reverse) : null)
      return
    }

    if (pathname === '/subnames') {
      const now = lifecycleClock(store)
      replyPage(filterRows(store.subnamesByParent.get(routeParams.parentNode) ?? [], (subname) => indexedSubnameBlocksRegistration(store, subname, now)))
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
      replyPage(marketOrders('Fixed', store.marketplaceFixedSalesByNode), (sale) => marketplaceOrderForResponse(store, sale))
      return
    }

    if (pathname === '/marketplace/fixed-sale') {
      reply(200, marketplaceOrderForResponse(store, singularOrder('Fixed', store.marketplaceFixedSalesByNode?.get(routeParams.node) ?? null)))
      return
    }

    if (pathname === '/marketplace/auctions') {
      replyPage(marketOrders('Auction', store.marketplaceAuctionsByNode), (auction) => marketplaceOrderForResponse(store, auction))
      return
    }

    if (pathname === '/marketplace/auction') {
      reply(200, marketplaceOrderForResponse(store, singularOrder('Auction', store.marketplaceAuctionsByNode?.get(routeParams.node) ?? null)))
      return
    }

    if (pathname === '/marketplace/offers') {
      const offers = filterRows(marketOrders('Offer', store.marketplaceOffersByKey), (offer) => (
        (!routeParams.node || offer.node === routeParams.node)
        && (!routeParams.buyerAuthority || offer.buyerAuthority === routeParams.buyerAuthority)
      ))
      replyPage(offers)
      return
    }

    if (pathname === '/marketplace/offer') {
      reply(200, singularOrder('Offer', store.marketplaceOffersByKey?.get(marketplaceOfferKey(routeParams.node, routeParams.buyerAuthority)) ?? null))
      return
    }

    if (pathname === '/marketplace/refund') {
      reply(200, store.marketplaceRefundsByAuthority?.get(routeParams.authority) ?? null)
      return
    }

    reply(404, { error: 'not_found', message: 'Route not found.' })
  } catch (error) {
    if (error instanceof IncompleteReplayError) {
      reply(503, { error: 'incomplete_replay', message: 'No complete index publication is available; repair the event history.' })
      return
    }
    logger.error({ requestId, error })
    reply(500, { error: 'internal_error', requestId })
  }
}

class IncompleteReplayError extends Error {}

async function resolveStore(storeProvider, allowUnavailable = false) {
  const store = typeof storeProvider === 'function' ? await storeProvider() : storeProvider
  if (store.unavailable && !allowUnavailable) throw new IncompleteReplayError()
  return store
}

function marketplaceOrderForResponse(store, order) {
  if (!order) return null
  const node = routeOrderNode(order.node)
  const marketplaceContractId = normalizedHex(order.marketplaceContractId)
  return {
    ...order,
    node,
    marketplaceContractId,
    namespace: namespaceSummary(store, node, order.sellerAuthority),
    escrowed: (store.frozen ? order.escrowed && store.namesByNode?.get(node)?.custody?.nonce === order.custodyNonce
      && store.namesByNode?.get(node)?.generation === order.generation && store.namesByNode?.get(node)?.serial === order.serial
      && store.namesByNode?.get(node)?.homeShard === order.homeShard : true) && indexedLifecycleBlocksRegistration(store.namesByNode?.get(node), lifecycleClock(store))
      && marketplaceOrderIsEscrowed(store.namesByNode?.get(node), marketplaceContractId),
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

function* filterRows(rows, matches) {
  for (const row of rows) if (matches(row)) yield row
}

function publicHealth(store, page, logger, requestId) {
  // One warning preserves the health check's degradation signal without copying the full history.
  const health = healthResponseForStore({ ...store, warnings: store.warnings?.length ? [store.warnings[0]] : [] })
  const warnings = paginate(store.warnings ?? [], page, (warning) => listKey('/health', warning))
  if (warnings.items.length || health.degradedReason || health.cursor?.reason || health.durability?.ok === false) {
    logger.warn({ requestId, warnings: warnings.items, degradedReason: health.degradedReason, cursor: health.cursor, durability: health.durability })
  }
  if (health.sqlite) health.sqlite = { ...health.sqlite, dbFile: undefined }
  if (health.degradedReason) health.degradedReason = { code: health.degradedReason.code, step: health.degradedReason.step, error: health.degradedReason.error, message: 'Indexer health is degraded; consult server logs.' }
  if (health.cursor) health.cursor = {
    ...health.cursor,
    reason: health.cursor.reason ? 'Collector is not ready; consult server logs.' : null,
  }
  if (health.durability) health.durability = {
    ...health.durability,
    message: health.durability.ok ? 'Durability checks passed.' : 'Durability checks failed; consult server logs.',
    eventLogFile: undefined,
    cursorFile: undefined,
    checkpointFile: undefined,
    checks: health.durability.checks?.map((check) => ({
      id: check.id, ok: check.ok, message: check.ok ? 'Check passed.' : 'Check failed; consult server logs.',
    })),
  }
  return {
    ...health,
    warnings: warnings.items.map((warning) => ({
      code: warning.code, step: warning.step, error: warning.error, line: warning.line, type: warning.type, message: 'Indexer warning; consult server logs.',
    })),
    nextCursor: warnings.nextCursor,
  }
}

function publicForward(store, name, page) {
  let activity = []
  // Resolve the current state as before, but select warnings before materializing a history.
  const body = resolveForward({
    ...store,
    namesByCanonical: { get(canonical) {
      const indexed = store.namesByCanonical.get(canonical)
      if (!indexed) return undefined
      activity = indexed.activity ?? []
      return { ...indexed, activity: [] }
    } },
    activityByNode: { get(node) {
      activity = store.activityByNode.get(node) ?? []
      return []
    } },
  }, name)
  const warnings = paginate(recentWarnings(activity, new Date(body.cache.asOf)), page, (row) => listKey('/resolve', row.entry))
  return { ...body, warnings: warnings.items.map((row) => row.warning), nextCursor: warnings.nextCursor }
}

function* recentWarnings(activity, now) {
  for (const entry of activity) {
    for (const warning of createRecentChangeWarnings([entry], now)) {
      yield { entry: { ...entry, id: `${entry.id}:${warning.target ?? warning.code}` }, warning }
    }
  }
}
