import { Resvg } from '@resvg/resvg-js'
import { afterEach, expect, it, vi } from 'vitest'
import { renderNameCard } from './card.mjs'

afterEach(() => vi.restoreAllMocks())

function render(name = 'aurora.dusk') {
  const renderer = vi.spyOn(Resvg.prototype, 'render')
  renderNameCard(name)
  const { pixels, width } = renderer.mock.results.at(-1).value
  const pixel = (x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)]
  // Read the actual glyph bounds, excluding the horizon and its similar colours.
  const textLines = (colour, top = 0, bottom = 340) => {
    const lines = []
    for (let y = top; y < bottom; y++) {
      const xs = []
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4
        if (colour.every((channel, i) => Math.abs(pixels[offset + i] - channel) <= 2)) xs.push(x)
      }
      if (!xs.length) continue
      let line = lines.at(-1)
      if (!line || line.bottom < y - 1) {
        line = { left: width, right: 0, top: y, bottom: y }
        lines.push(line)
      }
      line.left = Math.min(line.left, xs[0])
      line.right = Math.max(line.right, xs.at(-1))
      line.bottom = y
    }
    return lines
  }
  return { pixel, textLines }
}

const ink = [255, 245, 238]
const muted = [196, 182, 203]

it('places a peach sunset disc above the planet', () => {
  const { pixel } = render()
  const [r, g, b] = pixel(890, 390)
  expect(r).toBeGreaterThan(225)
  expect(g).toBeGreaterThan(170)
  expect(r - b).toBeGreaterThan(60)
  expect(pixel(770, 390)[0]).toBeLessThan(120)
  expect(pixel(890, 550)).toEqual([32, 21, 41])
})

it('renders a bright lilac-to-peach rim with a broad atmosphere above a dark planet', () => {
  const { pixel } = render()
  const lilac = pixel(600, 470)
  const peach = pixel(1040, 520)
  expect(lilac[2]).toBeGreaterThan(220)
  expect(lilac[2] - lilac[0]).toBeGreaterThan(15)
  expect(peach[0]).toBeGreaterThan(225)
  expect(peach[0] - peach[2]).toBeGreaterThan(30)
  expect(pixel(400, 462)[2] - pixel(400, 380)[2]).toBeGreaterThan(70)
  expect(pixel(400, 420)[2] - pixel(400, 380)[2]).toBeGreaterThan(15)
  expect(pixel(600, 550)).toEqual([32, 21, 41])
})

it.each(['aurora', 'afterglow'.repeat(3) + 'sky', 'w'.repeat(30), 'l'.repeat(63)])('keeps %s and its muted suffix inline within the card gutters', (label) => {
  const { textLines } = render(`${label}.dusk`)
  const labels = textLines(ink)
  const suffixes = textLines(muted)
  expect(labels).toHaveLength(1)
  expect(suffixes).toHaveLength(1)
  // Serif overhangs can share columns even though the two runs are inline.
  expect(suffixes[0].left).toBeGreaterThan(labels[0].right - 5)
  expect(suffixes[0].top).toBeLessThan(labels[0].bottom)
  expect(suffixes[0].bottom).toBeGreaterThan(labels[0].top)
  expect(labels[0].left).toBeGreaterThanOrEqual(70)
  expect(suffixes[0].right).toBeLessThanOrEqual(1130)
})

it.each(['afterglow'.repeat(7), 'w'.repeat(63)])('wraps %s at a readable minimum with an intact suffix on its own line', (label) => {
  const { textLines } = render(`${label}.dusk`)
  const labels = textLines(ink)
  const suffixes = textLines(muted)
  expect(labels).toHaveLength(2)
  expect(suffixes).toHaveLength(1)
  expect(suffixes[0].top).toBeGreaterThan(labels[1].bottom)
  expect(suffixes[0].bottom - suffixes[0].top).toBeGreaterThanOrEqual(32)
  expect(suffixes[0].right - suffixes[0].left).toBeGreaterThan(80)
  for (const line of [...labels, ...suffixes]) {
    expect(line.left).toBeGreaterThanOrEqual(70)
    expect(line.right).toBeLessThanOrEqual(1130)
    expect(line.bottom).toBeLessThan(340)
  }
  const widths = labels.map(line => line.right - line.left)
  expect(Math.min(...widths) / Math.max(...widths)).toBeGreaterThan(0.8)
})

it('keeps the wordmark small and muted', () => {
  const { textLines } = render()
  const wordmark = textLines(muted, 560, 620)
  expect(wordmark).toHaveLength(1)
  expect(wordmark[0].bottom - wordmark[0].top).toBeLessThan(24)
  expect(wordmark[0].right - wordmark[0].left).toBeLessThan(130)
  expect(textLines(ink, 560, 620)).toHaveLength(0)
})
