/**
 * Host revenue share basis points (bp).
 * 10,000 bp = 100%.
 * These constants are the single source of truth for all host point credit calculations.
 * Agency commission is calculated as a % of host points credited using these rates.
 */

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
   * Caller coin debit = ceil(pricePerMin * 10,000 / 6,000)
   * Host point credit = pricePerMin (their set price, exactly)
   * Effective host share of caller debit = 60%
   */
  VIDEO_CALL_HOST_SHARE_BP: 6_000,

  /** Multiplier to compute caller coin debit from host's set point price */
  VIDEO_CALL_CALLER_MARKUP_NUM: 10_000,
  VIDEO_CALL_CALLER_MARKUP_DEN: 6_000,
} as const

/** Convenience: host point credit from a gift */
export function hostPointsFromGift(coinCost: bigint): bigint {
  if (coinCost <= 0n) return 0n
  return (coinCost * BigInt(HOST_REVENUE_SHARES.GIFT_RECEIVE_BP)) / 10_000n
}

/** Convenience: host point credit from a subscription payment */
export function hostPointsFromSubscription(coinCost: bigint): bigint {
  if (coinCost <= 0n) return 0n
  return (coinCost * BigInt(HOST_REVENUE_SHARES.SUBSCRIPTION_BP)) / 10_000n
}

/** Convenience: host point credit from a guardian purchase */
export function hostPointsFromGuardian(coinCost: bigint): bigint {
  if (coinCost <= 0n) return 0n
  return (coinCost * BigInt(HOST_REVENUE_SHARES.GUARDIAN_PURCHASE_BP)) / 10_000n
}

/**
 * Caller coin debit for a video call minute.
 * hostPricePerMin is the points the host wants per minute.
 * Caller pays ceil(hostPricePerMin * 10000 / 6000) coins.
 */
export function callerCoinDebitForCall(hostPricePerMin: bigint): bigint {
  if (hostPricePerMin <= 0n) return 0n
  return (hostPricePerMin * 10_000n + 5_999n) / 6_000n // ceiling division
}
