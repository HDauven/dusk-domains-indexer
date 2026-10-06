import { blake2b } from '@noble/hashes/blake2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { setImmediate } from 'node:timers/promises'
import { normalizeName } from '../http.mjs'
import { nameValidationIssue } from '../naming.mjs'
import { indexedSubnameBlocksRegistration, lifecycleMomentPassed } from '../read-models/lifecycle.mjs'
import { escapeHtml } from './card.mjs'
import { siteConfig } from './site.mjs'

const sitemapLimit = 50_000
const authorityDomain = utf8ToBytes('dusk-domains:runtime-authority:v1')
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

// The app's labels: the SDK's record definitions, with the public address called "Dusk address".
// A Map, because record keys come from the chain and may be names such as "constructor".
const recordLabels = new Map([
  ['moonlight_address', 'Dusk address'],
  ['phoenix_payment_endpoint', 'Dusk Shielded Address'],
  ['dusk_contract', 'Dusk contract'],
  ['dusk_asset', 'Dusk asset'],
  ['evm_address', 'DuskEVM Address'],
  ['address.btc', 'Bitcoin address'],
  ['address.eth', 'Ethereum address'],
  ['address.sol', 'Solana address'],
  ['address.evm', 'EVM address'],
  ['website', 'Website'],
  ['avatar', 'Avatar'],
  ['content_pointer', 'Content pointer'],
  ['attestation_ref', 'Attestation reference'],
  ['compliance_ref', 'Compliance reference'],
])

function humanize(key) {
  const words = key.replace(/[._:-]+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function recordLabel(key) {
  if (recordLabels.has(key)) return recordLabels.get(key)
  if (key.startsWith('text.')) return humanize(key.slice('text.'.length))
  if (key.startsWith('service_endpoint.')) return `${humanize(key.slice('service_endpoint.'.length))} endpoint`
  return humanize(key)
}

function base58Decode(value) {
  if (typeof value !== 'string' || !value || value.length > 200) return null
  let number = 0n
  for (const character of value) {
    const digit = base58Alphabet.indexOf(character)
    if (digit < 0) return null
    number = number * 58n + BigInt(digit)
  }
  const bytes = []
  while (number > 0n) {
    bytes.unshift(Number(number % 256n))
    number /= 256n
  }
  for (const character of value) {
    if (character !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

/**
 * The owner's Dusk address, when one of the known addresses derives to the owner's
 * authority. The contract stores only the authority, so a payment record that points
 * elsewhere is never taken as the owner.
 */
export function ownerAddress(authority, candidates) {
  const wanted = String(authority ?? '').toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{64}$/.test(wanted)) return null
  for (const candidate of new Set(candidates)) {
    const key = base58Decode(candidate)
    if (key?.length !== 96) continue
    if (bytesToHex(blake2b(concatBytes(authorityDomain, key), { dkLen: 32 })) === wanted) return candidate
  }
  return null
}

function localCandidates(store, name, records) {
  const candidates = records.filter((record) => record.key === 'moonlight_address').map((record) => record.value)
  for (const entry of store.activityByNode?.get(name.node) ?? []) {
    const address = String(entry.target ?? '').match(/^moonlight_address:(.+)$/)?.[1]
    if (address && address !== 'cleared') candidates.push(address)
  }
  return candidates
}

const reverseIndexes = new WeakMap()

// The Dusk addresses that set a primary name, by the authority that set them. Built once per
// read model, so a crawl of many names does not rescan every reverse entry for each one.
function reverseAddressesByAuthority(reverseByEndpoint) {
  if (!reverseByEndpoint) return new Map()
  let index = reverseIndexes.get(reverseByEndpoint)
  if (!index) {
    index = new Map()
    for (const reverse of reverseByEndpoint.values()) {
      if (reverse?.endpoint?.type !== 'moonlight_address' || !reverse.controller) continue
      const authority = String(reverse.controller).toLowerCase()
      index.set(authority, [...(index.get(authority) ?? []), reverse.endpoint.value])
    }
    reverseIndexes.set(reverseByEndpoint, index)
  }
  return index
}

/** The owner's Dusk address, from the name's own records and activity, else its primary names. */
export function nameOwnerAddress(store, name, records) {
  return ownerAddress(name.owner, localCandidates(store, name, records))
    ?? ownerAddress(name.owner, reverseAddressesByAuthority(store.reverseByEndpoint).get(String(name.owner ?? '').toLowerCase()) ?? [])
}

function lifecycleFor(store, node) {
  return store.namesByNode.get(node) ?? store.subnamesByNode?.get(node)
}

/** Whether a name and every name above it are registered and not expired. */
export function activeNode(store, node, now, seen = new Set()) {
  if (seen.has(node)) return false
  seen.add(node)
  const lifecycle = lifecycleFor(store, node)
  if (!lifecycle || lifecycle.status !== 'active' || lifecycleMomentPassed(lifecycle.expiresAtBlockHeight, lifecycle.expiresAt, now)) return false
  return !lifecycle.parentNode || activeNode(store, lifecycle.parentNode, now, seen)
}

function nameUrl(name, origin) {
  return `${origin}/name/${encodeURIComponent(name)}`
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character])
}

const sitemapViews = new WeakMap()

// The read model's event count changes with every applied event. An incremental replay can
// keep the same maps, so the cache follows the count as well as the maps.
export function storeRevision(store) {
  return store.checkpoint?.eventCount ?? store.cursor?.eventCount ?? null
}

// Empty batches let background consumers yield while scanning activity or invalid names too.
function* sitemapCandidateBatches(store) {
  let count = 0
  const latest = new Map()
  for (const [node, entries] of store.activityByNode ?? []) {
    for (const entry of entries) {
      const time = Date.parse(entry.timestamp ?? '')
      if (Number.isFinite(time) && time > (latest.get(node) ?? -Infinity)) latest.set(node, time)
      if (++count % 1000 === 0) yield []
    }
  }
  let candidates = []
  for (const map of [store.namesByCanonical, store.subnamesByCanonical]) {
    for (const [name, entry] of map ?? []) {
      const canonical = normalizeName(name)
      if (canonical === name && !nameValidationIssue(canonical)) {
        candidates.push({ canonical, node: entry.node, lastmod: latest.get(entry.node) ?? null })
      }
      if (++count % 1000 === 0) {
        yield candidates
        candidates = []
      }
    }
  }
  if (candidates.length) yield candidates
}

// The newest activity time of every node, and every name the name page accepts, newest first.
// Both change only when events are applied.
function sitemapCandidates(store) {
  const revision = storeRevision(store)
  const cached = sitemapViews.get(store.namesByNode)
  if (cached && cached.revision === revision) return cached
  const candidates = []
  for (const batch of sitemapCandidateBatches(store)) candidates.push(...batch)
  candidates.sort((a, b) => (b.lastmod ?? 0) - (a.lastmod ?? 0) || a.canonical.localeCompare(b.canonical))
  const view = { candidates, revision, xml: null, clockKey: null }
  sitemapViews.set(store.namesByNode, view)
  return view
}

// Some lifecycles expire by date rather than height, so the minute counts even when the height is known.
function clockKey(now) {
  const date = now instanceof Date ? now : now?.date instanceof Date ? now.date : new Date()
  return `${now?.blockHeight ?? '-'}:${Math.floor(date.getTime() / 60_000)}`
}

/** Active sitemap candidates, without the XML sitemap's 50,000 URL limit. */
export function* namesSitemapEntries(store, now, { origin } = siteConfig()) {
  for (const { canonical, node, lastmod } of sitemapCandidates(store).candidates) {
    if (!activeNode(store, node, now)) continue
    yield { url: nameUrl(canonical, origin), lastmod: lastmod === null ? null : new Date(lastmod).toISOString() }
  }
}

/** Unsorted active candidates, yielding to the event loop after at most 1,000 entries. */
export async function* namesSitemapEntriesAsync(store, now, { origin } = siteConfig()) {
  for (const batch of sitemapCandidateBatches(store)) {
    for (const { canonical, node, lastmod } of batch) {
      if (!activeNode(store, node, now)) continue
      yield { url: nameUrl(canonical, origin), lastmod: lastmod === null ? null : new Date(lastmod).toISOString() }
    }
    await setImmediate()
  }
}

/**
 * Every registered, unexpired root name and subname that the name page serves, newest
 * activity first. The XML is rebuilt only when events arrive, the chain height changes or a
 * minute passes.
 */
export function namesSitemap(store, now, { origin } = siteConfig()) {
  const view = sitemapCandidates(store)
  const key = `${origin}:${clockKey(now)}`
  if (view.xml !== null && view.clockKey === key) return view.xml
  const urls = []
  for (const { url, lastmod } of namesSitemapEntries(store, now, { origin })) {
    if (urls.length === sitemapLimit) break
    urls.push(`  <url>
    <loc>${xmlEscape(url)}</loc>${lastmod === null ? '' : `
    <lastmod>${lastmod}</lastmod>`}
  </url>`)
  }
  view.xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}${urls.length ? '\n' : ''}</urlset>
`
  view.clockKey = key
  return view.xml
}

function liveSubnames(store, parentNode, now) {
  return (store.subnamesByParent?.get(parentNode) ?? [])
    .filter((subname) => indexedSubnameBlocksRegistration(store, subname, now) && activeNode(store, subname.node, now))
    .map((subname) => subname.canonicalName ?? subname.name)
    .filter(Boolean)
    .sort()
}

function recordValueHtml(record) {
  const value = String(record.value ?? '')
  if ((record.key === 'website' || record.key === 'avatar') && /^https:\/\//i.test(value)) {
    return `<a href="${escapeHtml(value)}" rel="nofollow ugc noopener">${escapeHtml(value)}</a>`
  }
  return `<code>${escapeHtml(value)}</code>`
}

function page({ title, description, canonical, image, index, noindex, body }) {
  const meta = (attribute, key, value) => `<meta ${attribute}="${key}" content="${escapeHtml(value)}">`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${meta('name', 'description', description)}
${meta('name', 'robots', noindex ? 'noindex' : index ? 'index,follow' : 'noindex,follow')}
${meta('property', 'og:site_name', 'Dusk Domains')}
${meta('property', 'og:type', 'website')}
${meta('property', 'og:title', title)}
${meta('property', 'og:description', description)}
${meta('property', 'og:image', image)}
${meta('property', 'og:image:width', '1200')}
${meta('property', 'og:image:height', '630')}
${meta('property', 'og:url', canonical)}
${meta('name', 'twitter:card', 'summary_large_image')}
${meta('name', 'twitter:title', title)}
${meta('name', 'twitter:description', description)}
${meta('name', 'twitter:image', image)}
<link rel="canonical" href="${escapeHtml(canonical)}">
</head><body>
${body}
</body></html>`
}

function dateOf(iso) {
  const time = Date.parse(iso ?? '')
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null
}

const bareId = (value) => String(value ?? '').toLowerCase().replace(/^0x/, '')

// The contract refuses to renew a name while a market contract holds it as owner or manager,
// and a listing closed after the name expired does not hand it back.
function heldByMarket(store, name) {
  const markets = new Set([
    ...(store.deployment?.contracts?.marketplace?.contractIds ?? []),
    store.marketplaceFixedSalesByNode?.get(name.node)?.marketplaceContractId,
    store.marketplaceAuctionsByNode?.get(name.node)?.marketplaceContractId,
  ].map(bareId).filter(Boolean))
  return markets.has(bareId(name.owner)) || markets.has(bareId(name.manager))
}

function expiredSentence(canonical, entry) {
  const date = dateOf(entry.expiresAt)
  return date ? `${canonical} expired on ${date}.` : `${canonical} has expired.`
}

/**
 * Why a known name is not active. A root past its expiry but still in grace can be renewed by
 * anyone until grace ends, unless the market holds it; after that anyone can register it. A subname is inactive when it or
 * a name above it has expired.
 */
function inactiveNotice(store, name, canonical, now) {
  if (!name.parentNode) {
    if (name.status === 'released' || !name.owner) return 'This name is not registered.'
    const graceEnds = dateOf(name.graceEndsAt)
    const inGrace = !lifecycleMomentPassed(name.graceEndsAtBlockHeight, name.graceEndsAt, now)
    if (inGrace && heldByMarket(store, name)) {
      return `${expiredSentence(canonical, name)} It was in the market when it expired, so it cannot be renewed. Anyone can register it again ${graceEnds ? `after ${graceEnds}` : 'once its grace period ends'}.`
    }
    if (inGrace) return `${expiredSentence(canonical, name)} Its owner, or anyone else, can renew it${graceEnds ? ` until ${graceEnds}` : ''}.`
    return `${expiredSentence(canonical, name)} Anyone can register it again.`
  }
  if (name.status !== 'active') return 'This name is not registered.'
  if (lifecycleMomentPassed(name.expiresAtBlockHeight, name.expiresAt, now)) return expiredSentence(canonical, name)
  let parent = lifecycleFor(store, name.parentNode)
  const seen = new Set([name.node])
  while (parent && !seen.has(parent.node)) {
    seen.add(parent.node)
    const parentName = parent.canonicalName ?? parent.name
    if (parent.status !== 'active' || lifecycleMomentPassed(parent.expiresAtBlockHeight, parent.expiresAt, now)) {
      return `${canonical} is not active, because ${parentName} has expired.`
    }
    parent = parent.parentNode ? lifecycleFor(store, parent.parentNode) : null
  }
  return 'This name is not registered.'
}

/**
 * The name page as plain HTML, for crawlers that do not run scripts. It is served at the
 * name's own URL, so it shows the facts the app shows and does not redirect.
 */
export function crawlerPage(store, canonical, now, defaultDescription, { origin, noindex } = siteConfig()) {
  // A root past its grace period leaves the active maps but keeps its lifecycle.
  const name = canonical
    ? store.namesByCanonical.get(canonical) ?? store.subnamesByCanonical?.get(canonical) ?? store.lifecyclesByCanonical?.get(canonical)
    : null
  if (!canonical || !name || !activeNode(store, name.node, now)) {
    const shown = canonical || 'This name'
    const notice = !canonical
      ? 'This is not a valid .dusk name.'
      : name ? inactiveNotice(store, name, canonical, now) : 'This name is not registered.'
    return {
      status: canonical ? 200 : 404,
      html: page({
        title: canonical ? `${canonical} · Dusk Domains` : 'Dusk Domains',
        description: defaultDescription,
        canonical: canonical ? nameUrl(canonical, origin) : `${origin}/`,
        image: `${origin}/og-image.png`,
        index: false,
        noindex,
        body: `<main>
<h1>${escapeHtml(shown)}</h1>
<p>${escapeHtml(notice)}</p>
<p><a href="${escapeHtml(canonical ? nameUrl(canonical, origin) : `${origin}/`)}">Search Dusk Domains</a></p>
</main>`,
      }),
    }
  }

  const records = (store.recordsByNode.get(name.node) ?? []).filter((record) => record.visibility === 'public' && record.value)
  const description = records.find((record) => record.key === 'text.description')?.value?.trim()
  const listed = records.filter((record) => record.key !== 'text.description').sort((a, b) => recordLabel(a.key).localeCompare(recordLabel(b.key)))
  const address = nameOwnerAddress(store, name, records)
  const expires = Date.parse(name.expiresAt ?? '')
  const subnames = liveSubnames(store, name.node, now)
  const facts = [
    ['Owner', address ? `<code>${escapeHtml(address)}</code>` : `<code>${escapeHtml(name.owner ?? '')}</code> (owner ID)`],
    ...(Number.isFinite(expires) ? [['Expires', escapeHtml(new Date(expires).toISOString().slice(0, 10))]] : []),
  ]
  const body = `<main>
<h1>${escapeHtml(canonical)}</h1>
${description ? `<p>${escapeHtml(description)}</p>\n` : ''}<dl>
${facts.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('\n')}
</dl>
<h2>Records</h2>
${listed.length ? `<dl>
${listed.map((record) => `<dt>${escapeHtml(recordLabel(record.key))}</dt><dd>${recordValueHtml(record)}</dd>`).join('\n')}
</dl>` : '<p>No public records.</p>'}
${subnames.length ? `<h2>Subnames</h2>
<ul>
${subnames.map((subname) => `<li><a href="${escapeHtml(nameUrl(subname, origin))}">${escapeHtml(subname)}</a></li>`).join('\n')}
</ul>
` : ''}<p><a href="${escapeHtml(nameUrl(canonical, origin))}">Open ${escapeHtml(canonical)} in Dusk Domains</a></p>
</main>`
  return {
    status: 200,
    html: page({
      title: `${canonical} · Dusk Domains`,
      description: description || defaultDescription,
      canonical: nameUrl(canonical, origin),
      image: `${origin}/api/share/name/${encodeURIComponent(canonical)}.png`,
      index: true,
      noindex,
      body,
    }),
  }
}
