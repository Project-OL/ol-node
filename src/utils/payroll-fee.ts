/**
 * Payroll withdrawal fee calculation utilities.
 * @see docs/flow-md/rates-levels-and-earnings-reference.md § 8. Payroll, withdrawal fees & agent processing rewards
 */
import { DEFAULT_PAYROLL_FEE_TIERS } from '../config/payroll-fee-tiers.defaults'
import { POINTS_PER_USD } from './points-currency'

/** Minimum payroll withdrawal (100,000 points). */
export const MIN_PAYROLL_POINTS = 100_000n

/** 1 lakh = 100_000 points (2L = 200k, 10L = 1M). */
export const WITHDRAWAL_LAKH_POINTS = 100_000n

export type PayrollFeeTierRates = {
  minPoints: bigint
  maxPoints: bigint | null
  platformFeeRateBp: number
  agentRewardRateBp: number
}

export type PayrollFeeTierDto = {
  minPoints: string
  maxPoints: string | null
  minUsd: number
  maxUsd: number | null
  platformFeeRateBp: number
  agentRewardRateBp: number
  sortOrder: number
}

export function pointsToUsdNumber(points: bigint): number {
  return Number(points) / Number(POINTS_PER_USD)
}

export function usdToPoints(usd: number): bigint {
  return BigInt(Math.round(usd * Number(POINTS_PER_USD)))
}

export function formatPayrollFeeTierDto(
  row: PayrollFeeTierRates & { sortOrder: number },
): PayrollFeeTierDto {
  return {
    minPoints: row.minPoints.toString(),
    maxPoints: row.maxPoints == null ? null : row.maxPoints.toString(),
    minUsd: pointsToUsdNumber(row.minPoints),
    maxUsd: row.maxPoints == null ? null : pointsToUsdNumber(row.maxPoints),
    platformFeeRateBp: row.platformFeeRateBp,
    agentRewardRateBp: row.agentRewardRateBp,
    sortOrder: row.sortOrder,
  }
}

export function defaultPayrollFeeTierDtos(): PayrollFeeTierDto[] {
  return DEFAULT_PAYROLL_FEE_TIERS.map((t, i) =>
    formatPayrollFeeTierDto({
      minPoints: t.minPoints,
      maxPoints: t.maxPoints,
      platformFeeRateBp: t.platformFeeRateBp,
      agentRewardRateBp: t.agentRewardRateBp,
      sortOrder: i + 1,
    }),
  )
}

export function parsePayrollFeeTiers(
  tiers: PayrollFeeTierDto[] | undefined | null,
): PayrollFeeTierRates[] {
  if (!tiers?.length) return []
  return tiers.map((t) => ({
    minPoints: BigInt(t.minPoints),
    maxPoints: t.maxPoints == null || t.maxPoints === '' ? null : BigInt(t.maxPoints),
    platformFeeRateBp: t.platformFeeRateBp,
    agentRewardRateBp: t.agentRewardRateBp,
  }))
}

export function matchPayrollFeeTier(
  grossPoints: bigint,
  tiers: readonly PayrollFeeTierRates[],
): PayrollFeeTierRates {
  const sorted = [...tiers].sort((a, b) => (a.minPoints < b.minPoints ? -1 : 1))
  for (const tier of sorted) {
    if (grossPoints < tier.minPoints) continue
    if (tier.maxPoints != null && grossPoints >= tier.maxPoints) continue
    return tier
  }
  return sorted[sorted.length - 1] ?? DEFAULT_PAYROLL_FEE_TIERS[DEFAULT_PAYROLL_FEE_TIERS.length - 1]!
}

/**
 * Platform fee + agent reward share for a gross withdrawal.
 * Uses configured `feeTiers` when present; otherwise the hardcoded 5% / 3% / 2%
 * ladder and `fallbackAgentRewardRateBp` (legacy singleton).
 */
export function resolvePayrollFeeRates(
  grossPoints: bigint,
  opts?: {
    feeTiers?: PayrollFeeTierDto[] | null
    fallbackAgentRewardRateBp?: number
  },
): { platformFeeRateBp: number; agentRewardRateBp: number } {
  const parsed = parsePayrollFeeTiers(opts?.feeTiers)
  if (parsed.length > 0) {
    const tier = matchPayrollFeeTier(grossPoints, parsed)
    return {
      platformFeeRateBp: tier.platformFeeRateBp,
      agentRewardRateBp: tier.agentRewardRateBp,
    }
  }
  return {
    platformFeeRateBp: resolveDefaultPlatformFeeRateBp(grossPoints),
    agentRewardRateBp: opts?.fallbackAgentRewardRateBp ?? 6000,
  }
}

/**
 * Platform fee rate (basis points) by gross withdrawal points.
 * Uses the default ladder when no DB tiers are supplied.
 *
 * | Gross points      | Platform fee |
 * |-------------------|--------------|
 * | 0 – under 2L      | 5% (500 bp)  |
 * | 2L – under 10L    | 3% (300 bp)  |
 * | 10L and above     | 2% (200 bp)  |
 */
export function resolvePlatformFeeRateBp(
  grossPoints: bigint,
  feeTiers?: PayrollFeeTierDto[] | null,
): number {
  return resolvePayrollFeeRates(grossPoints, { feeTiers }).platformFeeRateBp
}

function resolveDefaultPlatformFeeRateBp(grossPoints: bigint): number {
  return matchPayrollFeeTier(grossPoints, DEFAULT_PAYROLL_FEE_TIERS).platformFeeRateBp
}

/**
 * Calculate tiered platform fee for host withdrawals.
 */
export function calculateTieredPlatformFee(
  grossPoints: bigint,
  feeTiers?: PayrollFeeTierDto[] | null,
): bigint {
  const rateBp = resolvePlatformFeeRateBp(grossPoints, feeTiers)
  return (grossPoints * BigInt(rateBp)) / 10_000n
}
