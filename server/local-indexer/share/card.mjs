import { Resvg } from '@resvg/resvg-js'
import { fileURLToPath } from 'node:url'

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

function nameLayout(name) {
  const label = name ? name.replace(/\.dusk$/, '') : 'Dusk Domains'
  const suffix = name ? '.dusk' : ''
  const maximum = 110
  const minimum = 48
  const width = 1040
  const measure = (text) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="12000" height="200"><text y="120" font-family="Instrument Serif" font-size="${maximum}">${text}</text></svg>`, { font }).getBBox()?.width || 1
  const naturalWidth = measure(signature(label, suffix))
  const size = Math.max(minimum, Math.min(maximum, maximum * width / naturalWidth))
  if (naturalWidth * size / maximum <= width + 0.01) return { size, lines: [signature(label, suffix)] }

  // Like NameSignature, wrap the label only at the minimum and keep .dusk intact.
  const lines = []
  let remaining = label
  while (remaining) {
    const remainingWidth = measure(escapeHtml(remaining)) * size / maximum
    const lineWidth = Math.min(width, remainingWidth / Math.ceil(remainingWidth / width) + size / 2)
    let low = 1
    let high = remaining.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (measure(escapeHtml(remaining.slice(0, middle))) * size / maximum <= lineWidth) low = middle
      else high = middle - 1
    }
    lines.push(escapeHtml(remaining.slice(0, low)))
    remaining = remaining.slice(low)
  }
  if (suffix) lines.push(signature('', suffix))
  return { size, lines }
}

export function renderNameCard(name) {
  const { size, lines } = nameLayout(name)
  const lineHeight = size * 1.15
  const baseline = 260 - (lines.length - 1) * lineHeight / 2
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <linearGradient id="sky" x2="0.3" y2="1">
        <stop stop-color="#171222"/><stop offset="0.6" stop-color="#35223c"/><stop offset="1" stop-color="#58344b"/>
      </linearGradient>
      <linearGradient id="disc" x2="0.2" y2="1">
        <stop stop-color="#f2c5ab"/><stop offset="1" stop-color="#d79588"/>
      </linearGradient>
      <linearGradient id="rim">
        <stop stop-color="#b173df"/><stop offset="0.55" stop-color="#d4b5eb"/><stop offset="0.8" stop-color="#f2c5ab"/><stop offset="1" stop-color="#d79588"/>
      </linearGradient>
      <filter id="atmosphere" x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
      <filter id="glow" x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="12"/></filter>
    </defs>
    <rect width="1200" height="630" fill="url(#sky)"/>
    <circle cx="890" cy="458" r="106" fill="#f2c5ab" opacity="0.4" filter="url(#atmosphere)"/>
    <circle cx="890" cy="458" r="98" fill="url(#disc)"/>
    <ellipse cx="600" cy="855" rx="900" ry="400" fill="url(#rim)" opacity="0.85" filter="url(#atmosphere)"/>
    <ellipse cx="600" cy="870" rx="900" ry="400" fill="none" stroke="url(#rim)" stroke-width="14" filter="url(#glow)"/>
    <ellipse cx="600" cy="870" rx="900" ry="400" fill="#201529" stroke="url(#rim)" stroke-width="3"/>
    <g font-family="Instrument Serif" text-anchor="middle" fill="#fff5ee">
      ${lines.map((line, index) => `<text x="600" y="${baseline + index * lineHeight}" font-size="${size}">${line}</text>`).join('')}
      <text x="600" y="592" font-size="24" fill="#c4b6cb">dusk.domains</text>
    </g>
  </svg>`
  return new Resvg(svg, { font }).render().asPng()
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
