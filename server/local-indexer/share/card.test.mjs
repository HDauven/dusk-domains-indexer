import { Resvg } from '@resvg/resvg-js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { ANIMALS, constellation, LAYOUT } from './card-core.js'
import { cardIdentity, footerSvg, nameCardSvg, renderNameCard } from './card.mjs'

const vectors = JSON.parse(readFileSync(new URL('./test-fixtures/vectors.json', import.meta.url)))
const font = {
  loadSystemFonts: false,
  fontFiles: ['', '-italic'].map(suffix => fileURLToPath(new URL(`./fonts/instrument-serif${suffix}.ttf`, import.meta.url))),
}
const animalNames = {
  owl: 'quietfox', bat: 'moonrise', fox: 'hein', wolf: 'aurora', moth: 'smith', hedgehog: 'starling',
  raccoon: 'vesper', cat: 'sorrel', heron: 'tminus', tarsier: 'ember', gecko: 'orchard', frog: 'emberly',
}
const longest = character => `${Array(5).fill(character.repeat(63)).join('.')}.dusk`

afterEach(() => vi.restoreAllMocks())

function isolated(contents) {
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><g font-family="Instrument Serif" text-anchor="middle" fill="#fff5ee">${contents}</g></svg>`, { font })
}

function parts(svg) {
  return {
    heading: svg.match(/<g id="card-name">([\s\S]*?)<\/g>\n/)[1],
    constellation: svg.match(/<g transform="translate\([\s\S]*?<\/g>[\s\S]*?<\/g>/)[0].replaceAll('url(#starglow)', '#fff'),
    animal: svg.match(/<image [^>]+\/>/)[0],
  }
}

function raster(name) {
  const renderer = vi.spyOn(Resvg.prototype, 'render')
  const png = renderNameCard(name, 'dusk.domains')
  const rendered = renderer.mock.results.at(-1).value
  renderer.mockRestore()
  return { png, ...rendered, pixels: rendered.pixels, width: rendered.width, height: rendered.height }
}

function pixel(pixels, x, y) {
  return [...pixels.subarray((y * 1200 + x) * 4, (y * 1200 + x) * 4 + 3)]
}

it.each(vectors)('matches the approved namehash, animal, sky seed and star for $name', vector => {
  const { nodeHex, animal, skyKey, star } = cardIdentity(vector.name)
  expect({ node: nodeHex, animal, skyKey: skyKey.toString(), star: {
    x: Number(star.x.toFixed(3)), y: Number(star.y.toFixed(3)),
  } }).toEqual({ node: vector.node, animal: vector.animal, skyKey: vector.skyKey, star: vector.star })
  // The actual SVG uses that star position, rounded only for the one-decimal card geometry.
  expect(nameCardSvg(vector.name)).toContain(`<circle cx="${star.x.toFixed(1)}" cy="${star.y.toFixed(1)}" r="14" fill="url(#ownglow)"/>`)
})

it('keeps the approved animal order fixed', () => {
  expect(ANIMALS).toEqual(Object.keys(animalNames))
})

it('reserves space below the wrapped name band even at the largest constellation tilts and scale', () => {
  const animals = JSON.parse(readFileSync(new URL('./animals.json', import.meta.url)))
  for (const animal of ANIMALS) {
    for (const rotate of [-5, 0, 5]) {
      const stars = constellation(animals[animal].facets, { ...LAYOUT.stars, jitter: 1.02, rotate, rand: () => 1, mirror: true })
      expect(isolated(stars.replaceAll('url(#starglow)', '#fff')).getBBox().y).toBeGreaterThanOrEqual(124)
    }
  }
})

it.each(Object.entries(animalNames))('renders the embedded paper %s and its mirrored constellation', (animal, label) => {
  const name = `${label}.dusk`
  expect(cardIdentity(name).animal).toBe(animal)
  const svg = nameCardSvg(name)
  const elements = parts(svg)
  expect(elements.constellation).toContain('<line ')
  expect(svg).not.toMatch(/href="(?:https?:|file:)/)
  const { png, pixels, width, height } = raster(name)
  expect([width, height]).toEqual([1200, 630])
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  // Check nearly opaque paper pixels against the asset rendered alone. This catches
  // missing/unsupported embedded images even when the rest of the PNG is valid.
  const paper = isolated(elements.animal).render().pixels
  let matching = 0
  for (let y = 160; y < 360; y++) {
    for (let x = 80; x < 600; x++) {
      const offset = (y * 1200 + x) * 4
      if (paper[offset + 3] >= 250 && [0, 1, 2].every(c => Math.abs(pixels[offset + c] - paper[offset + c]) <= 6)) matching++
    }
  }
  expect(matching).toBeGreaterThan(100)
})

const layoutCases = [
  ['one letter', 'a.dusk', 1],
  ['descenders', 'gypqj.dusk', 1],
  ['medium', 'nightshade-gardener.dusk', 1],
  ['medium wide', `${'afterglow'.repeat(3)}sky.dusk`, 1],
  ['thirty wide letters', `${'w'.repeat(30)}.dusk`, 1],
  ['sixty-three narrow letters', `${'l'.repeat(63)}.dusk`, 1],
  ['two lines', `${'w'.repeat(63)}.dusk`, 2],
  ['current SDK maximum', `${Array(4).fill('w'.repeat(63)).join('.')}.dusk`, 3],
  ['five maximum-width labels', longest('w'), 3],
  ['five narrow labels', longest('i'), 3],
  ['five labels with descenders', longest('g'), 3],
  ['mixed maximum labels', `${Array(5).fill('gypqj'.repeat(12) + 'gyp').join('.')}.dusk`, 3],
]

it.each(layoutCases)('keeps %s complete, inside the top band and clear of both figures', (_, name, count) => {
  const elements = parts(nameCardSvg(name))
  const rows = [...elements.heading.matchAll(/<text [^>]*>([\s\S]*?)<\/text>/g)]
  expect(rows).toHaveLength(count)
  expect(elements.heading.replace(/<[^>]*>/g, '')).toBe(name)
  expect(rows.at(-1)[1]).toMatch(/<tspan font-style="italic" fill="#c4b6cb">\.dusk<\/tspan>$/)
  expect((elements.heading.match(/>\.dusk</g) ?? [])).toHaveLength(1)
  for (const [, size] of elements.heading.matchAll(/font-size="([\d.]+)"/g)) {
    expect(Number(size)).toBeGreaterThanOrEqual(32)
    expect(Number(size)).toBeLessThanOrEqual(96)
  }
  const heading = isolated(elements.heading)
  const box = heading.getBBox()
  expect(box.x).toBeGreaterThanOrEqual(79.99)
  expect(box.x + box.width).toBeLessThanOrEqual(1120.01)
  expect(box.y).toBeGreaterThanOrEqual(8)
  expect(box.y + box.height).toBeLessThanOrEqual(count > 1 ? 116.01 : 154)
  for (const figure of [elements.constellation, elements.animal]) {
    const obstacle = isolated(figure).getBBox()
    expect(box.x + box.width <= obstacle.x || box.x >= obstacle.x + obstacle.width || box.y + box.height <= obstacle.y - 7.99).toBe(true)
  }
  // Raster bounds also stay inside the gutters and band (no SVG viewport clipping).
  const { pixels } = heading.render()
  let visible = 0
  for (let y = 0; y < 630; y++) {
    for (let x = 0; x < 1200; x++) {
      if (pixels[(y * 1200 + x) * 4 + 3] > 0) {
        visible++
        if (x < 79 || x > 1121 || y < 7 || y > 154) throw new Error(`Name pixel outside bounds at ${x}, ${y}`)
      }
    }
  }
  expect(visible).toBeGreaterThan(100)
})

it('preserves the sunset, illuminated rim and dark foreground', () => {
  const { pixels } = raster('tminus.dusk')
  const disc = pixel(pixels, 890, 390)
  expect(disc[0]).toBeGreaterThan(225)
  expect(disc[1]).toBeGreaterThan(170)
  expect(disc[0] - disc[2]).toBeGreaterThan(60)
  const lilac = pixel(pixels, 600, 470)
  const peach = pixel(pixels, 1040, 520)
  expect(lilac[2]).toBeGreaterThan(220)
  expect(lilac[2] - lilac[0]).toBeGreaterThan(15)
  expect(peach[0]).toBeGreaterThan(225)
  expect(peach[0] - peach[2]).toBeGreaterThan(30)
  expect(pixel(pixels, 600, 550)).toEqual([32, 21, 41])
})

it('keeps the generic preview and the configured site mark and footer', () => {
  const svg = nameCardSvg('aurora.dusk')
  expect(svg).toMatch(/<svg x="[\d.]+" y="570" width="28" height="28" viewBox="0 0 512 512">[\s\S]*?<\/svg><text x="[\d.]+" y="592" font-size="24" text-anchor="start" fill="#c4b6cb">dusk\.domains<\/text>/)
  expect(svg.match(/\bid="mark-sky"/g)).toHaveLength(1)
  expect(footerSvg(null)).toBe('<text x="600" y="592" font-size="24" fill="#c4b6cb">dusk.domains</text>')
  expect(parts(nameCardSvg('')).heading.replace(/<[^>]*>/g, '')).toBe('Dusk Domains')
})

it('matches the approved tminus.dusk PNG golden (resvg and bundled fonts are pinned)', () => {
  expect(createHash('sha256').update(renderNameCard('tminus.dusk', 'dusk.domains')).digest('hex')).toBe('e9776b44627c790c7942604d2f24d00844f0578cfd17e2fd874bac9f6eaf468b')
})
