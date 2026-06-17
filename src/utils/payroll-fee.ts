/**
 * Payroll withdrawal fee calculation utilities.
 * @see docs/flow-md/rates-levels-and-earnings-reference.md § 8. Payroll, withdrawal fees & agent processing rewards
 */

/** Minimum payroll withdrawal (100,000 points). */
export const MIN_PAYROLL_POINTS = 100_000n

/** 1 lakh = 100_000 points (2L = 200k, 10L = 1M). */
export const WITHDRAWAL_LAKH_POINTS = 100_000n

const TWO_LAKH = 2n * WITHDRAWAL_LAKH_POINTS
const TEN_LAKH = 10n * WITHDRAWAL_LAKH_POINTS

/**
 * Platform fee rate (basis points) by gross withdrawal points.
 *
 * | Gross points      | Platform fee |
 * |-------------------|--------------|
 * | 0 – under 2L      | 5% (500 bp)  |
 * | 2L – under 10L    | 3% (300 bp)  |
 * | 10L and above     | 2% (200 bp)  |
 */
export function resolvePlatformFeeRateBp(grossPoints: bigint): number {
  if (grossPoints < TWO_LAKH) return 500
  if (grossPoints < TEN_LAKH) return 300
  return 200
}

/**
 * Calculate tiered platform fee for host withdrawals.
 */
export function calculateTieredPlatformFee(grossPoints: bigint): bigint {
  const rateBp = resolvePlatformFeeRateBp(grossPoints)
  return (grossPoints * BigInt(rateBp)) / 10_000n
}
