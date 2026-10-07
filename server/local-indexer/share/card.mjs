import { childNode, namehashHex } from '@duskdomains/sdk'
import { createHash } from 'node:crypto'
import { ANIMALS, TAGS, animalFor, LAYOUT, nameSizeFor, nameStar, starCardSvg } from './card-core.js'
import { Resvg } from '@resvg/resvg-js'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { siteConfig } from './site.mjs'

const font = {
  loadSystemFonts: false,
  fontFiles: ['', '-italic'].map((suffix) => fileURLToPath(new URL(`./fonts/instrument-serif${suffix}.ttf`, import.meta.url))),
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function signature(label, suffix = '') {
  return `${escapeHtml(label)}<tspan font-style="italic" fill="#c4b6cb">${suffix}</tspan>`
}

// Keep the canonical core untouched; font measurement and wrapping belong to this renderer.
// Even at maximum jitter/rotation, the constellation's glow stays below y=118.
const nameBand = { top: 8, bottom: 116, floor: 32 }
const animals = JSON.parse(readFileSync(new URL('./animals.json', import.meta.url)))
const artByAnimal = new Map(ANIMALS.map(animal => [animal, {
  ...animals[animal],
  href: `data:image/png;base64,${readFileSync(new URL(`./paper-png/${animal}.png`, import.meta.url)).toString('base64')}`,
}]))

export function cardIdentity(name) {
  const labels = name.split('.')
  // SDK 0.3.0 accepts four data labels plus .dusk. Extended renderer inputs use
  // its same child-node operation; HTTP validation retains the SDK's depth limit.
  let nodeHex = namehashHex(labels.slice(-5).join('.'))
  for (const label of labels.slice(0, -5).toReversed()) nodeHex = Buffer.from(childNode(Buffer.from(nodeHex, 'hex'), label)).toString('hex')
  const node = Buffer.from(nodeHex, 'hex')
  const key = tag => createHash('sha256').update(tag).update(node).digest().readBigUInt64BE(0)
  const skyKey = key(TAGS.sky)
  return { nodeHex, animal: animalFor(key(TAGS.animal)), skyKey, star: nameStar(nodeHex) }
}

function boundsOf(contents, withFonts = false) {
  const box = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="40000" height="630">${contents}</svg>`, { font: withFonts ? font : { loadSystemFonts: false } }).getBBox()
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

function nameLayout(label, suffix, obstacles) {
  // Cache measurements only during this layout, so arbitrary names cannot grow a second cache.
  const measurements = new Map()
  const measure = markup => {
    if (!measurements.has(markup)) measurements.set(markup, boundsOf(`<text font-family="Instrument Serif" text-anchor="middle" font-size="110">${markup}</text>`, true))
    return measurements.get(markup)
  }
  const extent = box => 2 * Math.max(-box.x, box.x + box.width)
  const whole = signature(label, suffix)
  const box = measure(whole)
  const width = extent(box)
  const size = Math.floor(nameSizeFor(width) * 10) / 10
  const text = (markup, size, y) => `<text x="600" y="${y}" font-size="${size}">${markup}</text>`
  if (width * size / 110 <= LAYOUT.nameWidth) {
    let baseline = LAYOUT.nameY
    const left = 600 + box.x * size / 110
    const right = left + box.width * size / 110
    // Preserve the approved baseline unless real glyph bounds approach either figure.
    for (const obstacle of obstacles) {
      if (left < obstacle.x + obstacle.width && right > obstacle.x) {
        baseline = Math.min(baseline, obstacle.y - 8 - (box.y + box.height) * size / 110)
      }
    }
    return text(whole, size, baseline)
  }

  // Balance by measured width, splitting labels if necessary. The suffix is one token,
  // so it always stays intact on the final line, never omitted or ellipsized.
  const tokens = [...label, ...(suffix ? [suffix] : [])]
  const markup = (start, end) => signature(tokens.slice(start, Math.min(end, label.length)).join(''), end === tokens.length ? suffix : '')
  const balance = count => {
    const lines = []
    let start = 0
    for (let remaining = count; remaining > 1; remaining--) {
      const target = extent(measure(markup(start, tokens.length))) / remaining
      let low = start + 1
      let high = tokens.length - (remaining - 1)
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (extent(measure(markup(start, mid))) <= target) low = mid
        else high = mid - 1
      }
      lines.push(markup(start, low))
      start = low
    }
    lines.push(markup(start, tokens.length))
    return lines
  }
  for (const count of [2, 3]) {
    const lines = balance(count)
    const boxes = lines.map(measure)
    const widest = Math.max(...boxes.map(extent))
    const top = boxes[0].y / 110
    const bottom = (count - 1) * 1.15 + (boxes.at(-1).y + boxes.at(-1).height) / 110
    const availableSize = Math.min(LAYOUT.nameMin, 110 * LAYOUT.nameWidth / widest, (nameBand.bottom - nameBand.top) / (bottom - top))
    if (count === 2 && availableSize < nameBand.floor) continue
    const wrappedSize = Math.max(nameBand.floor, Math.floor(availableSize * 10) / 10)
    // Five wide 63-character labels cannot fit three lines at 32px without condensing.
    // Keep their full text and vertical legibility, and only compress the horizontal axis.
    const scaleX = Math.min(1, LAYOUT.nameWidth / (widest * wrappedSize / 110))
    const firstBaseline = nameBand.bottom - bottom * wrappedSize
    const rows = lines.map((line, i) => text(line, wrappedSize, firstBaseline + i * wrappedSize * 1.15)).join('')
    return `<g transform="translate(600 0) scale(${scaleX} 1) translate(-600 0)">${rows}</g>`
  }
}

// The site's small mark, written by the frontend's `npm run brand` with its ids prefixed.
const markFile = new URL('./mark.svg', import.meta.url)
const siteMark = existsSync(markFile) ? readFileSync(markFile, 'utf8').replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '') : null
const footer = { size: 24, baseline: 592, mark: 28, gap: 10 }
let footerMeasurement = null

// The mark and the site address, centred together under the name.
export function footerSvg(mark = siteMark, host = siteConfig().host) {
  const text = escapeHtml(host)
  if (!mark) return `<text x="600" y="${footer.baseline}" font-size="${footer.size}" fill="#c4b6cb">${text}</text>`
  if (footerMeasurement?.text !== text) footerMeasurement = { text, width: new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="200"><text y="120" font-family="Instrument Serif" font-size="${footer.size}">${text}</text></svg>`, { font }).getBBox()?.width || 0 }
  const left = 600 - (footer.mark + footer.gap + footerMeasurement.width) / 2
  return `<svg x="${left}" y="${footer.baseline - 22}" width="${footer.mark}" height="${footer.mark}" viewBox="0 0 512 512">${mark}</svg>`
    + `<text x="${left + footer.mark + footer.gap}" y="${footer.baseline}" font-size="${footer.size}" text-anchor="start" fill="#c4b6cb">${text}</text>`
}

export function renderNameCard(name, host = siteConfig().host) {
  return new Resvg(nameCardSvg(name, host), { font }).render().asPng()
}

export function nameCardSvg(name, host = siteConfig().host) {
  // Inactive/unknown names retain the generic preview rather than acquiring an identity.
  const { nodeHex, skyKey, animal } = cardIdentity(name || 'dusk.dusk')
  const art = artByAnimal.get(animal)
  const label = name ? name.replace(/\.dusk$/, '') : 'Dusk Domains'
  let svg = starCardSvg({ label, nodeHex, skyKey, facets: art.facets, art })
  // These two canonical elements are the only obstacles to the full-width name band.
  const constellation = svg.match(/<g transform="translate\([\s\S]*?<\/g>[\s\S]*?<\/g>/)[0].replaceAll('url(#starglow)', '#fff')
  const image = svg.match(/<image [^>]+\/>/)[0]
  const obstacles = [boundsOf(constellation), boundsOf(image)]
  const heading = nameLayout(label, name ? '.dusk' : '', obstacles)
  svg = svg.replace(/<text x="600" y="132"[^>]*>[\s\S]*?<\/text>/, `<g id="card-name">${heading}</g>`)
  return svg.replace('<text x="600" y="592" font-size="24" fill="#c4b6cb">dusk.domains</text>', footerSvg(siteMark, host))
}

// Both limits apply: a burst of distinct names cannot retain unbounded PNG data.
export function createCardCache({ maxEntries = 128, maxBytes = 16 * 1024 * 1024, render = renderNameCard } = {}) {
  const entries = new Map()
  let bytes = 0
  return {
    get(name) {
      if (entries.has(name)) {
        const png = entries.get(name)
        entries.delete(name)
        entries.set(name, png)
        return png
      }
      const png = render(name)
      if (png.length > maxBytes || maxEntries < 1) return png
      while (entries.size >= maxEntries || bytes + png.length > maxBytes) {
        const oldest = entries.keys().next().value
        bytes -= entries.get(oldest).length
        entries.delete(oldest)
      }
      entries.set(name, png)
      bytes += png.length
      return png
    },
  }
}
