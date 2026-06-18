/** Platform rate: 10,000 points = $1 USD. */
export const WITHDRAWAL_POINTS_PER_USD = 10_000

export function grossPointsFromUsd(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('amountUsd must be a positive finite number')
  }
  return BigInt(Math.round(amountUsd * WITHDRAWAL_POINTS_PER_USD))
}
