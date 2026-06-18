import { describe, expect, it } from 'vitest'
import { CoinTxType } from '@prisma/client'
import {
  COIN_TRANSACTION_CATEGORIES,
  resolveCoinHistoryTxTypes,
} from '../../src/config/coin-earnings-categories'

describe('coin transaction categories', () => {
  it('expands topup category', () => {
    const types = resolveCoinHistoryTxTypes(['topup'])
    expect(types).toEqual(
      expect.arrayContaining([
        CoinTxType.TRADING_TRANSFER_IN,
        CoinTxType.TOPUP,
        CoinTxType.ADJUSTMENT,
      ]),
    )
    expect(types).toHaveLength(3)
  })

  it('expands gift category to GIFT_SEND only', () => {
    expect(resolveCoinHistoryTxTypes(['gift'])).toEqual([CoinTxType.GIFT_SEND])
  })

  it('expands platform_reward category to VIP_REWARD only', () => {
    expect(resolveCoinHistoryTxTypes(['platform_reward'])).toEqual([CoinTxType.VIP_REWARD])
  })

  it('expands others category with spend and exchange types', () => {
    const types = resolveCoinHistoryTxTypes(['others'])
    expect(types).toEqual(
      expect.arrayContaining([
        CoinTxType.POINT_EXCHANGE_TO_COINS,
        CoinTxType.VIDEO_CALL,
        CoinTxType.CREATOR_SUBSCRIPTION,
        CoinTxType.GUARDIAN_PURCHASE,
        CoinTxType.STORE_ITEM_PURCHASE,
        CoinTxType.VIP_PURCHASE,
        CoinTxType.VIP_MEMBERSHIP_PURCHASE,
        CoinTxType.USERNAME_CHANGE,
      ]),
    )
    expect(types).toHaveLength(8)
  })

  it('merges multiple categories and dedupes raw types', () => {
    const types = resolveCoinHistoryTxTypes(['gift', 'GIFT_SEND', 'topup'])
    expect(types).toContain(CoinTxType.GIFT_SEND)
    expect(types).toContain(CoinTxType.TOPUP)
    expect(types?.filter((t) => t === CoinTxType.GIFT_SEND)).toHaveLength(1)
  })

  it('rejects unknown filter values', () => {
    expect(() => resolveCoinHistoryTxTypes(['mysteryChest'])).toThrow(
      /Invalid coin history type filter/,
    )
  })

  it('covers every category with at least one tx type', () => {
    for (const key of Object.keys(COIN_TRANSACTION_CATEGORIES)) {
      expect(
        COIN_TRANSACTION_CATEGORIES[key as keyof typeof COIN_TRANSACTION_CATEGORIES].length,
      ).toBeGreaterThan(0)
    }
  })
})
