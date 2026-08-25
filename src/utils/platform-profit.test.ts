import { describe, expect, it } from 'vitest'
import {
  profitFromCoinToPointSplit,
  profitFromFullCoinSink,
  profitFromWithdrawalFee,
  sumPlatformProfit,
  wouldBeNegative,
  ZERO_PLATFORM_PROFIT,
} from './platform-profit'

describe('profitFromCoinToPointSplit', () => {
  it('nets agency out of gift margin (10000 coins, 60% host, 4% of host to agency)', () => {
    const coinsSpent = 10_000n
    const hostPoints = 6_000n
    const agency = (hostPoints * 400n) / 10_000n // 240
    const { buckets, rawCoins } = profitFromCoinToPointSplit({
      coinsSpent,
      hostPoints,
      agencyCommissionPoints: agency,
    })
    expect(agency).toBe(240n)
    expect(rawCoins).toBe(3_760n)
    expect(buckets).toEqual({ coins: '3760', points: '0', tradingCoins: '0' })
  })

  it('without agency is coins − host only (old live/VC reporting bug)', () => {
    const { rawCoins } = profitFromCoinToPointSplit({
      coinsSpent: 10_000n,
      hostPoints: 6_000n,
    })
    expect(rawCoins).toBe(4_000n)
  })

  it('treats missing agency as 0 so message-gift math is unchanged when commission is 0', () => {
    const withZero = profitFromCoinToPointSplit({
      coinsSpent: 10_000n,
      hostPoints: 6_000n,
      agencyCommissionPoints: 0n,
    })
    const omitted = profitFromCoinToPointSplit({
      coinsSpent: 10_000n,
      hostPoints: 6_000n,
    })
    expect(withZero.rawCoins).toBe(omitted.rawCoins)
    expect(withZero.buckets.coins).toBe('4000')
  })

  it('clamps negative buckets to 0 but preserves rawCoins for anomaly detection', () => {
    const { buckets, rawCoins } = profitFromCoinToPointSplit({
      coinsSpent: 100n,
      hostPoints: 80n,
      agencyCommissionPoints: 50n,
    })
    expect(rawCoins).toBe(-30n)
    expect(wouldBeNegative(rawCoins)).toBe(true)
    expect(buckets.coins).toBe('0')
  })
})

describe('unchanged non-gift formulas', () => {
  it('full coin sink still returns the whole spend', () => {
    expect(profitFromFullCoinSink(5_000n)).toEqual({
      coins: '5000',
      points: '0',
      tradingCoins: '0',
    })
  })

  it('withdrawal fee is service + platform − agent', () => {
    const { buckets, rawPoints } = profitFromWithdrawalFee({
      platformFeePoints: 100n,
      serviceFeePoints: 50n,
      agentRewardPoints: 20n,
    })
    expect(rawPoints).toBe(130n)
    expect(buckets.points).toBe('130')
    expect(buckets.coins).toBe('0')
  })

  it('sumPlatformProfit adds buckets independently', () => {
    expect(
      sumPlatformProfit([
        { coins: '3760', points: '0', tradingCoins: '0' },
        { coins: '0', points: '130', tradingCoins: '0' },
      ]),
    ).toEqual({ coins: '3760', points: '130', tradingCoins: '0' })
  })

  it('ZERO_PLATFORM_PROFIT stays all zeros', () => {
    expect(ZERO_PLATFORM_PROFIT).toEqual({ coins: '0', points: '0', tradingCoins: '0' })
  })
})
