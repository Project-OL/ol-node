import { describe, it, expect } from 'vitest'
import { getMaxCallPriceForLevel, MIN_CALL_PRICE_COINS_PER_MIN } from '../../src/utils/call-price'

describe('getMaxCallPriceForLevel', () => {
  const cases: [number, number][] = [
    [1, 1800],
    [4, 1800],
    [5, 2400],
    [9, 2400],
    [10, 3000],
    [14, 3000],
    [15, 3600],
    [19, 3600],
    [20, 4800],
    [24, 4800],
    [25, 6000],
    [29, 6000],
    [30, 7200],
    [34, 7200],
    [35, 9600],
    [99, 9600],
  ]

  test.each(cases)('level %i → max %i coins/min', (level, expected) => {
    expect(getMaxCallPriceForLevel(level)).toBe(expected)
  })

  it('MIN_CALL_PRICE_COINS_PER_MIN is 1800', () => {
    expect(MIN_CALL_PRICE_COINS_PER_MIN).toBe(1800)
  })
})
