/**
 * Host revenue share basis points (bp).
 * 10,000 bp = 100%.
 * Defaults match migration seed; runtime authority is `host_revenue_share_config` via
 * `hostRevenueShareConfigService.getShares()`.
 */

export type HostRevenueShares = {
  giftReceiveBp: number
  subscriptionBp: number
  guardianPurchaseBp: number
  videoCallHostShareBp: number
}

/** Default / fallback shares (used only when DB/cache is unavailable). */
export const HOST_REVENUE_SHARES = {
  /** Gift: host receives 60% of the gift's coin cost as points */
  GIFT_RECEIVE_BP: 6_000,

  /**
   * Subscription: host receives 75% of the subscription coin cost as points.
   * Coin cost: 50,000. Host points: floor(50,000 * 7,500 / 10,000) = 37,500
   */
  SUBSCRIPTION_BP: 7_500,

  /**
   * Guardian: host receives 75% of the guardian coin cost as points.
   * SILVER/month 150,000 → 112,500 pts
   * GOLD/month   300,000 → 225,000 pts
   * KING/month 1,500,000 → 1,125,000 pts
   */
  GUARDIAN_PURCHASE_BP: 7_500,

  /**
   * Video call: host sets a price per minute in points (e.g. 1,800 pts/min).
   * Caller is charged coins at the markup rate so host receives exactly pricePerMin points.
   * Caller coin debit = ceil(pricePerMin * 10,000 / hostShareBp)
   * Host point credit = pricePerMin (their set price, exactly)
   * Effective host share of caller debit = hostShareBp / 10000
   */
  VIDEO_CALL_HOST_SHARE_BP: 6_000,

  /** Multiplier to compute caller coin debit from host's set point price (legacy fixed 60%). */
  VIDEO_CALL_CALLER_MARKUP_NUM: 10_000,
  VIDEO_CALL_CALLER_MARKUP_DEN: 6_000,
} as const

export const DEFAULT_HOST_REVENUE_SHARES: HostRevenueShares = {
  giftReceiveBp: HOST_REVENUE_SHARES.GIFT_RECEIVE_BP,
  subscriptionBp: HOST_REVENUE_SHARES.SUBSCRIPTION_BP,
  guardianPurchaseBp: HOST_REVENUE_SHARES.GUARDIAN_PURCHASE_BP,
  videoCallHostShareBp: HOST_REVENUE_SHARES.VIDEO_CALL_HOST_SHARE_BP,
}

/** Convenience: host point credit from a gift */
export function hostPointsFromGift(
  coinCost: bigint,
  giftReceiveBp: number = HOST_REVENUE_SHARES.GIFT_RECEIVE_BP,
): bigint {
  if (coinCost <= 0n) return 0n
  return (coinCost * BigInt(giftReceiveBp)) / 10_000n
}

/** Convenience: host point credit from a subscription payment */
export function hostPointsFromSubscription(
  coinCost: bigint,
  subscriptionBp: number = HOST_REVENUE_SHARES.SUBSCRIPTION_BP,
): bigint {
  if (coinCost <= 0n) return 0n
  return (coinCost * BigInt(subscriptionBp)) / 10_000n
}

/** Convenience: host point credit from a guardian purchase */
export function hostPointsFromGuardian(
  coinCost: bigint,
  guardianPurchaseBp: number = HOST_REVENUE_SHARES.GUARDIAN_PURCHASE_BP,
): bigint {
  if (coinCost <= 0n) return 0n
  return (coinCost * BigInt(guardianPurchaseBp)) / 10_000n
}

/**
 * Caller coin debit for a video call minute.
 * hostPricePerMin is the points the host wants per minute.
 * Caller pays ceil(hostPricePerMin * 10000 / hostShareBp) coins.
 */
export function callerCoinDebitForCall(
  hostPricePerMin: bigint,
  hostShareBp: number = HOST_REVENUE_SHARES.VIDEO_CALL_HOST_SHARE_BP,
): bigint {
  if (hostPricePerMin <= 0n) return 0n
  const den = BigInt(hostShareBp)
  return (hostPricePerMin * 10_000n + den - 1n) / den // ceiling division
}
