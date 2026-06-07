/**
 * Fixed host revenue shares (basis points, 10_000 = 100%).
 * @see product rules: gifts 60%, subscription + guardian 50% of coin revenue → points.
 */

/** Host receives 60% of gift coin spend as points. */
export const HOST_GIFT_COIN_SHARE_BP = 6000

/** Host receives 50% of subscription / guardian coin revenue as points. */
export const HOST_COIN_REVENUE_SHARE_BP = 5000

/** Points credited to host from gift coin spend (integer coin units). */
export function hostGiftPointsFromCoinSpend(coinCost: number): number {
  if (coinCost <= 0) return 0
  return Math.floor((coinCost * HOST_GIFT_COIN_SHARE_BP) / 10_000)
}

/** Points credited to host from coin revenue (subscriptions, guardian, etc.). */
export function hostRevenuePointsFromCoins(coins: bigint): bigint {
  if (coins <= 0n) return 0n
  return (coins * BigInt(HOST_COIN_REVENUE_SHARE_BP)) / 10_000n
}
