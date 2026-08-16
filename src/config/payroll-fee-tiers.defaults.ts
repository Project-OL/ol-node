/**
 * Fallback payroll fee bands when `payroll_fee_tiers` is empty.
 * Production authority is the DB (admin soft-replace).
 *
 * Bounds are gross withdrawal points; max is exclusive.
 * 10_000 points = $1. 2L = 200_000 pts = $20. 10L = 1_000_000 pts = $100.
 */
export type PayrollFeeTierDefault = {
  minPoints: bigint
  maxPoints: bigint | null
  platformFeeRateBp: number
  agentRewardRateBp: number
}

export const DEFAULT_PAYROLL_FEE_TIERS: readonly PayrollFeeTierDefault[] = [
  { minPoints: 0n, maxPoints: 200_000n, platformFeeRateBp: 500, agentRewardRateBp: 6000 },
  { minPoints: 200_000n, maxPoints: 1_000_000n, platformFeeRateBp: 300, agentRewardRateBp: 6000 },
  { minPoints: 1_000_000n, maxPoints: null, platformFeeRateBp: 200, agentRewardRateBp: 6000 },
] as const
