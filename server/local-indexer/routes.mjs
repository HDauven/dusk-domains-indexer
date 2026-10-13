import { createWebsiteVerification } from './website-verification.mjs'
import { nameValidationIssue } from './naming.mjs'
import { premiumForName } from './read-models/premium.mjs'
import { namespaceForNode, namespaceSummary } from './read-models/namespace.mjs'
import { createShareHandler } from './share/routes.mjs'
import { indexNowConfig } from './indexnow.mjs'
import { randomUUID } from 'node:crypto'
import { LIST_FIELDS, listKey, pageParameters, paginate } from './pagination.mjs'
import { holdingsPage, namesPage } from './name-authority-index.mjs'
import { corsHeaders, createRateLimiter } from './security.mjs'
import { DEFAULT_FEE_CONFIG } from './constants.mjs'
import {
  emptyTreasuryState,
  referralStateFor,
  commitmentKey,
  unknownMarketplaceConfig,
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
  const verification = options.verification ?? createWebsiteVerification(storeProvider)
  const verifyIpLimit = createRateLimiter({ ...options, rateLimit: true, rateLimitMax: 5, rateLimitWindowMs: 60_000 })
  const verifyNameLimit = createRateLimiter({ now: options.now, rateLimit: true, rateLimitMax: 1, rateLimitWindowMs: 60_000 })
  const indexNow = options.indexNow ?? indexNowConfig()
  return (request, response) => {
    void handleRequest(storeProvider, request, response, { ...options, rateLimit, share, indexNow, verification, verifyIpLimit, verifyNameLimit })
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

    let url
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      reply(400, { error: 'invalid_url', message: 'Invalid request URL.' })
      return
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method !== (pathname === '/verify' ? 'POST' : 'GET')) {
      reply(405, { error: 'method_not_allowed', message: pathname === '/verify' ? 'Use POST or OPTIONS.' : 'Use GET or OPTIONS.' })
      return
    }

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
    const market = url.searchParams.get('marketplace')
    // `marketplace=all` answers from every admitted market; rows name their market.
    const allMarkets = market === 'all' && pathname.startsWith('/marketplace/')
    if (allMarkets && (pathname === '/marketplace/config' || pathname === '/marketplace/refund')) {
      reply(400, { error: 'invalid_marketplace', message: pathname === '/marketplace/refund'
        ? 'Name one marketplace, or list every market\'s refunds with /marketplace/refunds.' : 'Name one marketplace.' })
      return
    }
    // Order IDs are per market: across markets, the market keeps keys unique.
    const pageKey = item => {
      const key = listKey(pathname, item)
      return allMarkets && item.orderId != null ? [...key.slice(0, -1), `${key.at(-1)}:${item.marketplaceContractId}`] : key
    }
    const replyPage = (rows, map = (item) => item) => {
      const result = paginate(rows, page, pageKey)
      reply(200, { [LIST_FIELDS[pathname]]: result.items.map(map), nextCursor: result.nextCursor })
    }
    if (pathname === '/verify') {
      const canonical = normalizeName(url.searchParams.get('name'))
      if (url.searchParams.getAll('name').length !== 1 || nameValidationIssue(canonical)) {
        reply(400, { error: 'invalid_name', message: 'A valid name is required.' }); return
      }
      const retry = options.verifyIpLimit(request) || options.verifyNameLimit({ headers: {}, socket: { remoteAddress: canonical } })
      if (retry) { reply(429, { error: 'rate_limited', message: 'Try verification again later.' }, { 'retry-after': String(retry) }); return }
      const current = await resolveStore(storeProvider)
      const node = current.namesByCanonical.get(canonical)?.node ?? current.subnamesByCanonical?.get(canonical)?.node
      if (!node) { reply(404, { error: 'name_not_found' }); return }
      const verification = await options.verification.check(node)
      if (verification.status === 'retry') { reply(503, { error: 'verification_busy', message: 'Could not check DNS. Try again in a moment.' }); return }
      reply(200, { canonicalName: canonical, verification }); return
    }
    let store = await resolveStore(storeProvider, pathname === '/health')
    const withVerification = item => item ? { ...item, verification: options.verification.read(store, item.node) } : item
    const refundRows = store.marketplaceRefunds ?? [...(store.marketplaceRefundsByAuthority?.values() ?? [])]
    if (market && pathname.startsWith('/marketplace/') && !allMarkets) {
      const id = normalizeNode(market)
      if (!/^0x[0-9a-f]{64}$/.test(id)) { reply(400, { error: 'invalid_marketplace' }); return }
      const orders = (store.marketplaceOrders ?? []).filter(o => o.marketplaceContractId === id)
      store = { ...store,
        marketplaceConfig: store.marketplaceConfigs?.[id] ?? { ...unknownMarketplaceConfig(id),
          ...(store.marketplaceConfig?.marketplaces ? { marketplaces: store.marketplaceConfig.marketplaces } : {}) },
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
    // Snapshot stores hold the rows of the market they were written from, under every selector.
    const marketOrders = (kind, fallback) => store.frozen
      ? filterRows(store.marketplaceOrders ?? [], o => o.kind === kind && (allMarkets || o.marketplaceContractId === store.marketplaceConfig?.marketplaceContractId))
      : fallback?.values() ?? []
    // Without an order ID: the latest indexed match, in one market or across all of them.
    const singularOrder = (kind, fallback) => {
      if (orderId === null && !allMarkets) return fallback
      if (!store.frozen) return orderId === null ? fallback : null
      let latest = null
      for (const o of marketOrders(kind))
        if (o.node === routeParams.node && (orderId === null || o.orderId === BigInt(orderId).toString())
          && (!routeParams.buyerAuthority || o.buyerAuthority === routeParams.buyerAuthority)) latest = o
      return latest
    }

    if (pathname === '/health') {
      reply(200, publicHealth(store, page, logger, requestId))
      return
    }

    if (pathname === '/controllers') {
      const result = paginate(store.controllers ?? [], page, item => listKey(pathname, item))
      reply(200, { controllers: result.items, version: store.controllerVersion ?? '1', nextCursor: result.nextCursor })
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
      reply(200, { ...result, verification: options.verification.read(store, store.namesByCanonical.get(result.canonical)?.node ?? store.subnamesByCanonical?.get(result.canonical)?.node), nextCursor: null })
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
      reply(200, { names: result.items.map((name) => withVerification(byNode.get(name.node))), nextCursor: result.nextCursor })
      return
    }

    if (pathname === '/holdings') {
      const result = holdingsPage(store, routeParams.authority, page)
      if (result.error) {
        reply(503, result)
        return
      }
      reply(200, { holdings: result.items, nextCursor: result.nextCursor })
      return
    }

    if (pathname === '/resolve') {
      const name = url.searchParams.get('name') ?? ''
      const body = withVerification(publicForward(store, name, page))
      reply(body.errors.some((error) => error.code === 'missing_name') ? 400 : 200, body, {
        'cache-control': 'no-store',
      })
      return
    }

    if (pathname === '/name') {
      const node = routeParams.node
      const name = store.namesByNode.get(node) ?? subnameLifecycleForNode(store, node)
      reply(200, withVerification(name ? { ...name, ...premiumForName(store, name), namespace: namespaceForNode(store, node) } : null))
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
      replyPage(filterRows(store.subnamesByParent.get(routeParams.parentNode) ?? [], (subname) => indexedSubnameBlocksRegistration(store, subname, now)), withVerification)
      return
    }

    if (pathname === '/subname') {
      reply(200, withVerification(liveSubnameForNode(store, routeParams.node)))
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
      reply(200, store.marketplaceConfig ?? unknownMarketplaceConfig())
      return
    }

    if (pathname === '/marketplace/fixed-sales') {
      replyPage(marketOrders('Fixed', store.marketplaceFixedSalesByNode), (sale) => withVerification(marketplaceOrderForResponse(store, sale)))
      return
    }

    if (pathname === '/marketplace/fixed-sale') {
      reply(200, withVerification(marketplaceOrderForResponse(store, singularOrder('Fixed', store.marketplaceFixedSalesByNode?.get(routeParams.node) ?? null))))
      return
    }

    if (pathname === '/marketplace/auctions') {
      replyPage(marketOrders('Auction', store.marketplaceAuctionsByNode), (auction) => withVerification(marketplaceOrderForResponse(store, auction)))
      return
    }

    if (pathname === '/marketplace/auction') {
      reply(200, withVerification(marketplaceOrderForResponse(store, singularOrder('Auction', store.marketplaceAuctionsByNode?.get(routeParams.node) ?? null))))
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

    if (pathname === '/marketplace/refunds') {
      const only = market && !allMarkets ? normalizeNode(market) : null
      replyPage(filterRows(refundRows, r => normalizeNode(r.authority) === routeParams.authority
        && (!only || r.marketplaceContractId === only)))
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
    // `collector` publishes where and why it is blocked.
    blocked: undefined,
    // Status and code stay public; the collector logs each rejection's detail.
    ...(health.cursor.policyInitializations && typeof health.cursor.policyInitializations === 'object' ? {
      policyInitializations: Object.fromEntries(Object.entries(health.cursor.policyInitializations).map(([policy, row]) =>
        [policy, { status: row?.status, code: row?.code, retryAt: row?.retryAt, transaction: row?.transaction, blockHeight: row?.blockHeight }])),
    } : {}),
    ...(health.cursor.marketInitializations && typeof health.cursor.marketInitializations === 'object' ? {
      marketInitializations: Object.fromEntries(Object.entries(health.cursor.marketInitializations).map(([market, row]) =>
        [market, { status: row?.status, code: row?.code, retryAt: row?.retryAt, transaction: row?.transaction, blockHeight: row?.blockHeight,
          configTransaction: row?.configTransaction, configBlockHeight: row?.configBlockHeight }])),
    } : {}),
    // The collector's working set of unadmitted contracts is not part of the public API, and
    // `collector` publishes its quarantine.
    marketCandidates: undefined,
    marketCandidatesAt: undefined,
    marketCandidatesBytes: undefined,
    quarantine: undefined,
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
