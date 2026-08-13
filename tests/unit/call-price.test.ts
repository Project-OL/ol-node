import { describe, it, expect } from 'vitest'
import { getMaxCallPriceForLevel, MIN_CALL_PRICE_COINS_PER_MIN } from '../../src/utils/call-price'

describe('getMaxCallPriceForLevel', () => {
  // Lv10+ is a single "maximum gating" band offering multiple selectable prices
  // (3000/3600/4800/6000/7200); getMaxCallPriceForLevel returns the max of all
  // rows matching the level, so every level >= 10 caps at 7200 (see
  // docs/context/CURRENT_CONTEXT.md "Video call price caps = maximum gating (2026-08-09)").
  const cases: [number, number][] = [
    [1, 1800],
    [4, 1800],
    [5, 2400],
    [9, 2400],
    [10, 7200],
    [14, 7200],
    [15, 7200],
    [19, 7200],
    [20, 7200],
    [24, 7200],
    [25, 7200],
    [29, 7200],
    [30, 7200],
    [34, 7200],
    [35, 7200],
    [99, 7200],
  ]

  test.each(cases)('level %i → max %i coins/min', (level, expected) => {
    expect(getMaxCallPriceForLevel(level)).toBe(expected)
  })

  it('MIN_CALL_PRICE_COINS_PER_MIN is 1800', () => {
    expect(MIN_CALL_PRICE_COINS_PER_MIN).toBe(1800)
  })
})
