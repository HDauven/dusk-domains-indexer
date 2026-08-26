import { describe, expect, it } from 'vitest'
import { isMain } from './is-main.mjs'

describe('isMain', () => {
  it('uses native main metadata when available', () => {
    expect(isMain({ main: true, url: 'file:///tmp/tool.mjs' }, ['node', '/tmp/other.mjs'])).toBe(true)
    expect(isMain({ main: false, url: 'file:///tmp/tool.mjs' }, ['node', '/tmp/tool.mjs'])).toBe(false)
  })

  it('falls back to the entry script URL on early Node 24 releases', () => {
    expect(isMain({ url: 'file:///tmp/tool.mjs' }, ['node', '/tmp/tool.mjs'])).toBe(true)
    expect(isMain({ url: 'file:///tmp/tool.mjs' }, ['node', '/tmp/other.mjs'])).toBe(false)
  })
})
