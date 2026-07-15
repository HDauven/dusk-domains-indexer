import { describe, expect, it } from 'vitest'
import { assertSafeNumericTree, checkedSafeSum, safeNonNegativeInteger } from './safe-numbers.mjs'

describe('indexer safe integer boundaries', () => {
  it('accepts exact event and snapshot values', () => {
    expect(() => assertSafeNumericTree({ amountLux: Number.MAX_SAFE_INTEGER }, 'event')).not.toThrow()
    expect(safeNonNegativeInteger('9007199254740991', 'amount')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rejects unsafe numbers, bigint values and numeric strings', () => {
    expect(() => assertSafeNumericTree({ amountLux: 9_007_199_254_740_992 }, 'event')).toThrow('unsafe')
    expect(() => assertSafeNumericTree({ amount_lux: 9_007_199_254_740_993n }, 'event')).toThrow('unsafe')
    expect(() => assertSafeNumericTree({ amountLux: '9007199254740993' }, 'snapshot')).toThrow('unsafe')
  })

  it('rejects derived totals that cannot be represented exactly', () => {
    expect(() => checkedSafeSum(Number.MAX_SAFE_INTEGER, 1, 'refund')).toThrow('safe integer range')
  })
})
