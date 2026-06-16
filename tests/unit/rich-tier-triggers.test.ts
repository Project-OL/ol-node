import { describe, expect, it } from 'vitest'
import { CoinTxType } from '@prisma/client'
import { RECHARGE_TX_TYPES } from '../../src/services/rich-tier.service'

/**
 * Rich tier monthly progress increases only when personal COIN enters the wallet from
 * an external source. RECHARGE_TX_TYPES is the single gate used by recharge call sites.
 */
describe('Rich tier recharge triggers', () => {
  it('RECHARGE_TX_TYPES contains exactly TOPUP, TRADING_TRANSFER_IN, ADJUSTMENT', () => {
    expect(RECHARGE_TX_TYPES.has(CoinTxType.TOPUP)).toBe(true)
    expect(RECHARGE_TX_TYPES.has(CoinTxType.TRADING_TRANSFER_IN)).toBe(true)
    expect(RECHARGE_TX_TYPES.has(CoinTxType.ADJUSTMENT)).toBe(true)
    expect(RECHARGE_TX_TYPES.size).toBe(3)
  })

  it('does NOT treat spend/grant/exchange tx types as recharge', () => {
    expect(RECHARGE_TX_TYPES.has(CoinTxType.VIP_REWARD)).toBe(false)
    expect(RECHARGE_TX_TYPES.has(CoinTxType.GIFT_SEND)).toBe(false)
    expect(RECHARGE_TX_TYPES.has(CoinTxType.POINT_EXCHANGE_TO_COINS)).toBe(false)
  })
})
