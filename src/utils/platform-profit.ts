/**
 * Platform profit buckets (Phase 1 derivation).
 * Coin→point flows treat 1 coin ≈ 1 point unit (runtime economics).
 * Net of agency: profitCoins = coinsSpent − hostPoints − agencyCommissionPoints.
 */

export type PlatformProfitBuckets = {
  coins: string
  points: string
  tradingCoins: string
}

export const ZERO_PLATFORM_PROFIT: PlatformProfitBuckets = {
  coins: '0',
  points: '0',
  tradingCoins: '0',
}

function toNonNegString(n: bigint): string {
  return (n < 0n ? 0n : n).toString()
}

/** True when raw math would go negative (data anomaly). */
export function wouldBeNegative(raw: bigint): boolean {
  return raw < 0n
}

/**
 * Coin→point conversion retention (gifts, video calls, subscriptions, guardian).
 * Returns coins bucket only.
 */
export function profitFromCoinToPointSplit(params: {
  coinsSpent: bigint
  hostPoints: bigint
  agencyCommissionPoints?: bigint
}): { buckets: PlatformProfitBuckets; rawCoins: bigint } {
  const agency = params.agencyCommissionPoints ?? 0n
  const rawCoins = params.coinsSpent - params.hostPoints - agency
  return {
    rawCoins,
    buckets: {
      coins: toNonNegString(rawCoins),
      points: '0',
      tradingCoins: '0',
    },
  }
}

/** Full coin sink (store, VIP, username change, rare ID). */
export function profitFromFullCoinSink(coinsSpent: bigint): PlatformProfitBuckets {
  return {
    coins: toNonNegString(coinsSpent),
    points: '0',
    tradingCoins: '0',
  }
}

/**
 * Withdrawal net platform fee (points).
 * serviceFeePoints + platformFeePoints − agentRewardPoints.
 */
export function profitFromWithdrawalFee(params: {
  platformFeePoints: bigint
  agentRewardPoints?: bigint
  serviceFeePoints?: bigint
}): { buckets: PlatformProfitBuckets; rawPoints: bigint } {
  const agent = params.agentRewardPoints ?? 0n
  const service = params.serviceFeePoints ?? 0n
  const rawPoints = service + params.platformFeePoints - agent
  return {
    rawPoints,
    buckets: {
      coins: '0',
      points: toNonNegString(rawPoints),
      tradingCoins: '0',
    },
  }
}

export function sumPlatformProfit(
  parts: PlatformProfitBuckets[],
): PlatformProfitBuckets {
  let coins = 0n
  let points = 0n
  let tradingCoins = 0n
  for (const p of parts) {
    coins += BigInt(p.coins || '0')
    points += BigInt(p.points || '0')
    tradingCoins += BigInt(p.tradingCoins || '0')
  }
  return {
    coins: coins.toString(),
    points: points.toString(),
    tradingCoins: tradingCoins.toString(),
  }
}

export function addPlatformProfit(
  a: PlatformProfitBuckets,
  b: PlatformProfitBuckets,
): PlatformProfitBuckets {
  return sumPlatformProfit([a, b])
}
