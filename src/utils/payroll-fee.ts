/**
 * Payroll withdrawal fee calculation utilities.
 * @see docs/flow-md/rates-levels-and-earnings-reference.md § 8. Payroll, withdrawal fees & agent processing rewards
 */

/** Minimum payroll withdrawal (100,000 points). */
export const MIN_PAYROLL_POINTS = 100_000n

/**
 * Calculate tiered platform fee for host withdrawals.
 * Tier rules:
 * - 0–199,999 points: 5%
 * - 200,000–999,999 points: 3%
 * - ≥1,000,000 points: 2%
 */
export function calculateTieredPlatformFee(grossPoints: bigint): bigint {
  if (grossPoints < 200_000n) {
    return (grossPoints * 500n) / 10_000n // 5%
  } else if (grossPoints < 1_000_000n) {
    return (grossPoints * 300n) / 10_000n // 3%
  } else {
    return (grossPoints * 200n) / 10_000n // 2%
  }
}
