import { describe, expect, it } from 'vitest'
import {
  ADMIN_MANAGED_TAGS,
  hasCoinsellerAdminTag,
  isCoinsellerAdminTag,
  withCoinsellerAdminTag,
} from './adminTags'

describe('adminTags coinseller helpers', () => {
  it('recognizes common spellings', () => {
    expect(isCoinsellerAdminTag('coinseller')).toBe(true)
    expect(isCoinsellerAdminTag('Coin Seller')).toBe(true)
    expect(isCoinsellerAdminTag('coin_seller')).toBe(true)
    expect(isCoinsellerAdminTag('agency')).toBe(false)
  })

  it('adds canonical tag without wiping others', () => {
    expect(withCoinsellerAdminTag(['VIP', 'coin seller'], true)).toEqual([
      'VIP',
      ADMIN_MANAGED_TAGS.COINSELLER,
    ])
    expect(hasCoinsellerAdminTag(withCoinsellerAdminTag(['VIP'], true))).toBe(true)
  })

  it('removes any coinseller variant', () => {
    expect(withCoinsellerAdminTag(['VIP', 'Coin Seller', 'agency'], false)).toEqual([
      'VIP',
      'agency',
    ])
  })
})
