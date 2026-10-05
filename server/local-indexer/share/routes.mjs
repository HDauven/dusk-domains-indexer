import { normalizeName } from '../http.mjs'
import { nameValidationIssue } from '../naming.mjs'
import { lifecycleClock } from '../read-models/lifecycle.mjs'
import { createCardCache, escapeHtml } from './card.mjs'
import { activeNode, crawlerPage, namesSitemap } from './crawler.mjs'

const origin = 'https://dusk.domains'
const defaultDescription = 'Search, register and manage .dusk domains for Dusk wallets, contracts and apps.'

function previewForName(store, canonical) {
  const name = store.namesByCanonical.get(canonical) ?? store.subnamesByCanonical?.get(canonical)
  if (!name || !activeNode(store, name.node, lifecycleClock(store))) return null
  const description = (store.recordsByNode.get(name.node) ?? []).find((record) => record.key === 'text.description' && record.visibility === 'public')?.value
  return { name: canonical, description: description?.trim() || defaultDescription }
}

function previewHtml(preview) {
  const name = preview?.name
  const title = name ? `${name} · Dusk Domains` : 'Dusk Domains'
  const description = preview?.description ?? defaultDescription
  const url = name ? `${origin}/name/${encodeURIComponent(name)}` : `${origin}/`
  const image = name ? `${origin}/api/share/name/${encodeURIComponent(name)}.png` : `${origin}/og-image.png`
  const meta = (attribute, key, value) => `<meta ${attribute}="${key}" content="${escapeHtml(value)}">`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
${meta('name', 'description', description)}
${meta('property', 'og:site_name', 'Dusk Domains')}
${meta('property', 'og:type', 'website')}
${meta('property', 'og:title', title)}
${meta('property', 'og:description', description)}
${meta('property', 'og:image', image)}
${meta('property', 'og:image:width', '1200')}
${meta('property', 'og:image:height', '630')}
${meta('property', 'og:url', url)}
${meta('name', 'twitter:card', 'summary_large_image')}
${meta('name', 'twitter:title', title)}
${meta('name', 'twitter:description', description)}
${meta('name', 'twitter:image', image)}
<link rel="canonical" href="${escapeHtml(url)}">
<meta http-equiv="refresh" content="0;url=${escapeHtml(url)}">
</head><body><a href="${escapeHtml(url)}">Open Dusk Domains</a></body></html>`
}

export function createShareHandler() {
  const cards = createCardCache()
  const resolve = async (storeProvider) => typeof storeProvider === 'function' ? storeProvider() : storeProvider
  const crawlerHeaders = (headers, contentType) => ({
    ...headers,
    'content-type': contentType,
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  })
  return async (pathname, storeProvider, response, headers) => {
    if (pathname === '/sitemap/names.xml') {
      const store = await resolve(storeProvider)
      response.writeHead(200, crawlerHeaders(headers, 'application/xml; charset=utf-8'))
      response.end(namesSitemap(store, lifecycleClock(store)))
      return true
    }
    if (pathname.startsWith('/page/name/')) {
      let input = ''
      try { input = decodeURIComponent(pathname.slice('/page/name/'.length)) } catch { /* Malformed input gets the plain page. */ }
      const canonical = normalizeName(input)
      const valid = !nameValidationIssue(canonical)
      const store = valid ? await resolve(storeProvider) : null
      const result = crawlerPage(store, valid ? canonical : null, store ? lifecycleClock(store) : null, defaultDescription)
      response.writeHead(result.status, crawlerHeaders(headers, 'text/html; charset=utf-8'))
      response.end(result.html)
      return true
    }
    if (!pathname.startsWith('/share/name/')) return false
    let input = ''
    try { input = decodeURIComponent(pathname.slice('/share/name/'.length)) } catch { /* Malformed input gets the default preview. */ }
    const png = input.endsWith('.png') || pathname.endsWith('.png')
    const canonical = normalizeName(png ? input.slice(0, -4) : input)
    const valid = !nameValidationIssue(canonical)
    if (png && !valid) {
      response.writeHead(400, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(JSON.stringify({ error: 'invalid_name', message: 'Invalid name.' }))
      return true
    }
    const store = valid ? await (typeof storeProvider === 'function' ? storeProvider() : storeProvider) : null
    const preview = valid ? previewForName(store, canonical) : null
    const body = png ? cards.get(preview?.name ?? '') : previewHtml(preview)
    response.writeHead(200, {
      ...headers,
      'content-type': png ? 'image/png' : 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      ...(png ? {} : { 'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" }),
    })
    response.end(body)
    return true
  }
}
