// Shared with the frontend repo: this canonical geometry must change in both repos together.
// starcard-core.js: the concept-5 card geometry, shared verbatim by the Node renderer and the proposal page.
// Inputs are plain values: the namehash node (hex), 8-byte digests for the animal and sky, the animal's art.
export const ANIMALS = ['owl', 'bat', 'fox', 'wolf', 'moth', 'hedgehog', 'raccoon', 'cat', 'heron', 'tarsier', 'gecko', 'frog']
export const TAGS = { animal: 'dusk-domains:card:v1\0', sky: 'dusk-domains:card-sky:v1\0' }

// Jump consistent hash: names keep their animal when the set grows, except ~1/(n+1) of them.
export function jump(key, buckets) {
  let b = -1n, j = 0n
  while (j < BigInt(buckets)) {
    b = j
    key = (key * 2862933555777941757n + 1n) & 0xffffffffffffffffn
    j = BigInt(Math.floor(Number(b + 1n) * (2 ** 31 / Number((key >> 33n) + 1n))))
  }
  return Number(b)
}
export const animalFor = animalKey => ANIMALS[jump(animalKey, ANIMALS.length)]

// xorshift64 over the sky digest: per-name dust, tilt and offsets.
export function stream(skyKey) {
  let s = skyKey || 1n
  return () => { s ^= (s << 13n) & 0xffffffffffffffffn; s ^= s >> 7n; s ^= (s << 17n) & 0xffffffffffffffffn; return Number(s >> 11n) / 2 ** 53 }
}

// The same position the home page gives this name's star (SkyBackground.tsx namePosition), in card pixels.
export function nameStar(nodeHex) {
  const x = parseInt(nodeHex.slice(0, 8), 16) / 2 ** 32, y = parseInt(nodeHex.slice(8, 16), 16) / 2 ** 32
  return { x: (0.04 + x * 0.92) * 1200, y: (0.07 + y * 0.46) * 630 }
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const RX = 900, RY = 400, CX = 600, CY = 870
const rim = x => { const u = (x - CX) / RX, r = Math.sqrt(1 - u * u); return { y: CY - RY * r, angle: Math.atan2(RY * u, RX * r) * 180 / Math.PI } }

// Constellation lines: the silhouette plus the strong creases (adjacent folds far apart in tone).
export function constellation(facets, { cx, bottom, maxW, maxH, jitter, rotate, rand, mirror = false, lineOpacity = 0.2 }) {
  const edges = new Map()
  for (const f of facets) if (f.p && f.t !== undefined) f.p.forEach((a, i) => {
    const b = f.p[(i + 1) % f.p.length], key = [a, b].map(String).sort().join('|')
    const e = edges.get(key) ?? { a, b, tones: [] }
    e.tones.push(f.t); edges.set(key, e)
  })
  const chosen = [...edges.values()].filter(e => e.tones.length === 1 || Math.abs(e.tones[0] - e.tones[1]) >= 2)
  const degree = new Map()
  for (const e of chosen) for (const p of [e.a, e.b]) degree.set(String(p), (degree.get(String(p)) ?? 0) + 1)
  const ranked = [...degree.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
  const bright = new Set(ranked.slice(0, 7).map(([k]) => k))
  // Fit the figure's own bounds into the free sky, anchored at its bottom centre.
  const pts = ranked.map(([k]) => k.split(',').map(Number)), xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = Math.min(maxW / (maxX - minX), maxH / (maxY - minY), 1.8) * jitter
  const T = ([x, y]) => [(mirror ? -1 : 1) * (x - (minX + maxX) / 2) * scale, (y - maxY) * scale]
  const lines = chosen.map(({ a, b }) => { const [x1, y1] = T(a), [x2, y2] = T(b); return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>` }).join('')
  const stars = ranked.map(([k]) => {
    const [x, y] = T(k.split(',').map(Number))
    if (bright.has(k)) return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="url(#starglow)"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.9" fill="#fff5ee"/>`
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.9 + rand() * 0.6).toFixed(2)}" fill="#e9dcf3" opacity="${(0.45 + rand() * 0.35).toFixed(2)}"/>`
  }).join('')
  return `<g transform="translate(${cx.toFixed(1)} ${bottom.toFixed(1)}) rotate(${rotate.toFixed(2)})"><g stroke="#d4b5eb" stroke-opacity="${lineOpacity}" stroke-width="0.9" stroke-linecap="round">${lines}</g>${stars}</g>`
}

// Star dust like the home page: tiny ink stars, denser high in the sky, none on the planet.
function dust(rand, count = 90) {
  let out = ''
  for (let i = 0; i < count; i++) {
    const x = rand() * 1200, y = Math.pow(rand(), 1.6) * 430
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.5 + rand() * 0.8).toFixed(2)}" fill="#fff5ee" opacity="${(0.15 + rand() * 0.4).toFixed(2)}"/>`
  }
  return out
}

const DEFS = `
  <linearGradient id="sky" x2="0.3" y2="1"><stop stop-color="#171222"/><stop offset="0.6" stop-color="#35223c"/><stop offset="1" stop-color="#58344b"/></linearGradient>
  <linearGradient id="disc" x2="0.2" y2="1"><stop stop-color="#f2c5ab"/><stop offset="1" stop-color="#d79588"/></linearGradient>
  <linearGradient id="rim"><stop stop-color="#b173df"/><stop offset="0.55" stop-color="#d4b5eb"/><stop offset="0.8" stop-color="#f2c5ab"/><stop offset="1" stop-color="#d79588"/></linearGradient>
  <filter id="atmosphere" x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
  <filter id="glow" x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="12"/></filter>
  <radialGradient id="contact"><stop stop-color="#0e0a14" stop-opacity="0.75"/><stop offset="1" stop-color="#0e0a14" stop-opacity="0"/></radialGradient>
  <radialGradient id="starglow"><stop stop-color="#fff5ee" stop-opacity="0.9"/><stop offset="0.35" stop-color="#fff5ee" stop-opacity="0.25"/><stop offset="1" stop-color="#fff5ee" stop-opacity="0"/></radialGradient>
  <radialGradient id="ownglow"><stop stop-color="#ffe6d4" stop-opacity="1"/><stop offset="0.3" stop-color="#f2c5ab" stop-opacity="0.45"/><stop offset="1" stop-color="#f2c5ab" stop-opacity="0"/></radialGradient>`

// Layout: the name owns the top band at full width. The paper animal stands upright, large, left of centre,
// its base just beyond the planet's edge like a horizon. Its constellation rises opposite, above the sun,
// mirrored so the two face each other.
export const LAYOUT = { nameY: 132, nameMax: 96, nameMin: 48, nameWidth: 1040, animalX: 320, animalScale: 1.5, sink: 10, stars: { cx: 945, bottom: 345, maxW: 420, maxH: 195 } }
// The name's font size from its measured width at 110 px (regular label plus italic .dusk), as production fits it.
export const nameSizeFor = widthAt110 => Math.max(LAYOUT.nameMin, Math.min(LAYOUT.nameMax, 110 * LAYOUT.nameWidth / widthAt110))

// The whole card. art = { href, w, h, height, lift }; label is the name without .dusk.
export function starCardSvg({ label, nodeHex, skyKey, facets, art, nameSize = LAYOUT.nameMax }) {
  const rand = stream(skyKey), own = nameStar(nodeHex), animalX = LAYOUT.animalX
  const H = Math.round(art.height * LAYOUT.animalScale), lift = art.lift ?? 0, W = Math.round(art.w * H / art.h), { y } = rim(animalX)
  const st = LAYOUT.stars
  const sky = constellation(facets, { cx: st.cx + (rand() - 0.5) * 30, bottom: st.bottom, maxW: st.maxW, maxH: st.maxH, jitter: 0.94 + rand() * 0.08, rotate: (rand() - 0.5) * 10, rand, mirror: true })
  // Upright, base sunk just behind the rim; the planet is drawn after it and hides the base.
  const animal = `<image href="${art.href}" x="${(animalX - W / 2).toFixed(1)}" y="${(y + LAYOUT.sink - H - lift).toFixed(1)}" width="${W}" height="${H}"/>`
  const ownStar = `<circle cx="${own.x.toFixed(1)}" cy="${own.y.toFixed(1)}" r="14" fill="url(#ownglow)"/><circle cx="${own.x.toFixed(1)}" cy="${own.y.toFixed(1)}" r="2.4" fill="#ffe6d4"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>${DEFS}</defs>
  <rect width="1200" height="630" fill="url(#sky)"/>
  ${dust(rand)}
  ${sky}
  ${ownStar}
  <circle cx="890" cy="458" r="106" fill="#f2c5ab" opacity="0.4" filter="url(#atmosphere)"/>
  <circle cx="890" cy="458" r="98" fill="url(#disc)"/>
  ${animal}
  <ellipse cx="600" cy="855" rx="900" ry="400" fill="url(#rim)" opacity="0.85" filter="url(#atmosphere)"/>
  <ellipse cx="600" cy="870" rx="900" ry="400" fill="none" stroke="url(#rim)" stroke-width="14" filter="url(#glow)"/>
  <ellipse cx="600" cy="870" rx="900" ry="400" fill="#201529" stroke="url(#rim)" stroke-width="3"/>
  <g font-family="Instrument Serif" text-anchor="middle" fill="#fff5ee">
    <text x="600" y="${LAYOUT.nameY}" font-size="${nameSize.toFixed(1)}">${esc(label)}<tspan font-style="italic" fill="#c4b6cb">.dusk</tspan></text>
    <text x="600" y="592" font-size="24" fill="#c4b6cb">dusk.domains</text>
  </g>
</svg>`
}
