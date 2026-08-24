import type { CustomGiftConfig } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'

/** Supported custom-gift request durations (months). */
export const CUSTOM_GIFT_DURATION_MONTHS = [1, 3] as const
export type CustomGiftDurationMonths = (typeof CUSTOM_GIFT_DURATION_MONTHS)[number]

export type CustomGiftPackage = {
  durationMonths: CustomGiftDurationMonths
  /** Calendar days used for gift validity (30 / 90). */
  validityDays: number
  coinCost: string
  label: string
}

const DAYS_PER_MONTH = 30

export function validityDaysForDuration(durationMonths: CustomGiftDurationMonths): number {
  return durationMonths * DAYS_PER_MONTH
}

export function isCustomGiftDurationMonths(v: number): v is CustomGiftDurationMonths {
  return v === 1 || v === 3
}

/**
 * Resolve which package the client selected.
 * Prefer explicit `durationMonths`; otherwise map legacy `validityDays` 90 → 3 months,
 * anything else (including omitted) → 1 month.
 */
export function resolveCustomGiftDuration(params: {
  durationMonths?: number
  validityDays?: number
}): CustomGiftDurationMonths {
  if (params.durationMonths != null) {
    if (!isCustomGiftDurationMonths(params.durationMonths)) {
      throw new AppError(400, 'durationMonths must be 1 or 3', 'INVALID_CUSTOM_GIFT_DURATION')
    }
    return params.durationMonths
  }
  if (params.validityDays === 90) return 3
  return 1
}

export function coinCostForDuration(
  config: Pick<CustomGiftConfig, 'coinCost' | 'coinCost1Month' | 'coinCost3Months'>,
  durationMonths: CustomGiftDurationMonths,
): bigint {
  if (durationMonths === 3) return config.coinCost3Months
  // Prefer dedicated 1-month column; fall back to legacy coinCost.
  return config.coinCost1Month > 0n ? config.coinCost1Month : config.coinCost
}

export function buildCustomGiftPackages(
  config: Pick<CustomGiftConfig, 'coinCost' | 'coinCost1Month' | 'coinCost3Months'>,
): CustomGiftPackage[] {
  return [
    {
      durationMonths: 1,
      validityDays: validityDaysForDuration(1),
      coinCost: coinCostForDuration(config, 1).toString(),
      label: '1 month',
    },
    {
      durationMonths: 3,
      validityDays: validityDaysForDuration(3),
      coinCost: coinCostForDuration(config, 3).toString(),
      label: '3 months',
    },
  ]
}
