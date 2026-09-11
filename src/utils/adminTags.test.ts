import { describe, expect, it } from 'vitest'
import { composePublicAdminTags, DERIVED_ADMIN_TAGS, isCoinsellerAdminTag } from './adminTags'
import { isCoinsellerByTradingBalance } from './coinseller'

describe('adminTags coinseller derivation', () => {
  it('recognizes common spellings', () => {
    expect(isCoinsellerAdminTag('coinseller')).toBe(true)
    expect(isCoinsellerAdminTag('Coin Seller')).toBe(true)
    expect(isCoinsellerAdminTag('coin_seller')).toBe(true)
    expect(isCoinsellerAdminTag('agency')).toBe(false)
  })

  it('derives coinseller from trading balance for agencies', () => {
    const tags = composePublicAdminTags({
      stored: ['VIP'],
      isAgency: true,
      tradingBalance: 500_000,
    })
    expect(tags).toContain(DERIVED_ADMIN_TAGS.AGENCY)
    expect(tags).toContain(DERIVED_ADMIN_TAGS.COINSELLER)
    expect(tags).toContain('VIP')
  })

  it('does not derive coinseller below threshold and strips stored coinseller', () => {
    const tags = composePublicAdminTags({
      stored: ['coin seller', 'VIP'],
      isAgency: true,
      tradingBalance: 499_999,
    })
    expect(tags).toContain(DERIVED_ADMIN_TAGS.AGENCY)
    expect(tags).not.toContain(DERIVED_ADMIN_TAGS.COINSELLER)
    expect(tags).toContain('VIP')
    expect(tags.some(isCoinsellerAdminTag)).toBe(false)
  })

  it('isCoinsellerByTradingBalance respects threshold', () => {
    expect(isCoinsellerByTradingBalance(500_000)).toBe(true)
    expect(isCoinsellerByTradingBalance(499_999)).toBe(false)
    expect(isCoinsellerByTradingBalance(null)).toBe(false)
  })
})
