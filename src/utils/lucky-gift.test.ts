import { describe, expect, it } from 'vitest'
import { isLuckyGift } from './lucky-gift'

describe('isLuckyGift', () => {
  it('is lucky when the flag is set, whatever the category', () => {
    expect(isLuckyGift({ isLucky: true, category: null })).toBe(true)
    expect(isLuckyGift({ isLucky: true, category: { name: 'Gift', slug: 'gift' } })).toBe(true)
  })

  it('is lucky by category name or slug, ignoring case', () => {
    expect(isLuckyGift({ isLucky: false, category: { name: 'Lucky', slug: 'x' } })).toBe(true)
    expect(isLuckyGift({ isLucky: false, category: { name: 'lucky', slug: 'luckyy' } })).toBe(true)
    expect(isLuckyGift({ isLucky: false, category: { name: 'Other', slug: 'LUCKY' } })).toBe(true)
  })

  it('is not lucky otherwise', () => {
    expect(isLuckyGift({ isLucky: false, category: null })).toBe(false)
    expect(isLuckyGift({ isLucky: false })).toBe(false)
    expect(
      isLuckyGift({ isLucky: false, category: { name: 'Lucky Box', slug: 'lucky-box' } }),
    ).toBe(false)
  })
})
