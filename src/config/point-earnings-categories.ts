import { PointTxType } from '@prisma/client'

/** UI / API buckets for points earnings and history filters. */
export const POINT_EARNINGS_CATEGORIES = {
  livestream: [
    PointTxType.GIFT_RECEIVE,
    PointTxType.VIDEO_CALL,
    PointTxType.ADJUSTMENT,
    PointTxType.LIVESTREAM_GIFT, // legacy ledger rows
  ],
  commission: [PointTxType.AGENT_COMMISSION, PointTxType.PAYROLL_HOST_PAYOUT],
  transfer: [PointTxType.AGENT_POINT_TRANSFER, PointTxType.TRANSFER_OUT],
  platform_reward: [
    PointTxType.PAYROLL_PROCESSING_REWARD,
    PointTxType.PAYROLL_TAKEOVER_INVENTORY,
    PointTxType.PLATFORM_REWARD,
    PointTxType.LIVESTREAM_STREAK_REWARD, // rewards section: first-7-days livestream daily parts
  ],
  subscription: [PointTxType.SUBSCRIPTION, PointTxType.GUARDIAN_PURCHASE],
  withdraw: [
    PointTxType.WITHDRAWAL_ESCROW,
    PointTxType.WITHDRAWAL_ESCROW_SETTLED,
    PointTxType.WITHDRAWAL_REFUND,
  ],
} as const satisfies Record<string, PointTxType[]>

export type PointEarningsCategory = keyof typeof POINT_EARNINGS_CATEGORIES

export const POINT_EARNINGS_CATEGORY_KEYS = Object.keys(
  POINT_EARNINGS_CATEGORIES,
) as PointEarningsCategory[]

const CATEGORY_SET = new Set<string>(POINT_EARNINGS_CATEGORY_KEYS)

/** Narrow history filter aliases (rollup into `subscription` earnings bucket). */
export const POINT_HISTORY_FILTER_ALIASES = {
  /** Same earnings bucket as `subscription`; filters history to guardian credits only. */
  guardian: [PointTxType.GUARDIAN_PURCHASE],
} as const satisfies Record<string, PointTxType[]>

const ALIAS_SET = new Set<string>(Object.keys(POINT_HISTORY_FILTER_ALIASES))

const ALL_CATEGORY_TX_TYPES = new Set<PointTxType>(Object.values(POINT_EARNINGS_CATEGORIES).flat())

/** Raw ledger types allowed in `types` query (categories + aliases + individual tx types). */
export const POINT_HISTORY_FILTER_VALUES = [
  ...POINT_EARNINGS_CATEGORY_KEYS,
  ...Object.keys(POINT_HISTORY_FILTER_ALIASES),
  ...Object.values(PointTxType),
] as const

export type PointHistoryFilterValue = (typeof POINT_HISTORY_FILTER_VALUES)[number]

export function isPointEarningsCategory(value: string): value is PointEarningsCategory {
  return CATEGORY_SET.has(value)
}

/**
 * Expand history `types` query values (category aliases and/or raw PointTxType) to ledger types.
 */
export function resolvePointHistoryTxTypes(filters?: string[]): PointTxType[] | undefined {
  if (!filters?.length) return undefined

  const resolved = new Set<PointTxType>()
  const invalid: string[] = []

  for (const raw of filters) {
    if (isPointEarningsCategory(raw)) {
      for (const t of POINT_EARNINGS_CATEGORIES[raw]) {
        resolved.add(t)
      }
      continue
    }
    if (ALIAS_SET.has(raw)) {
      for (const t of POINT_HISTORY_FILTER_ALIASES[
        raw as keyof typeof POINT_HISTORY_FILTER_ALIASES
      ]) {
        resolved.add(t)
      }
      continue
    }
    if ((Object.values(PointTxType) as string[]).includes(raw)) {
      resolved.add(raw as PointTxType)
      continue
    }
    invalid.push(raw)
  }

  if (invalid.length > 0) {
    throw new Error(`Invalid point history type filter: ${invalid.join(', ')}`)
  }

  return resolved.size > 0 ? [...resolved] : undefined
}

export function sumCreditsByCategory(
  totalsByTxType: Partial<Record<PointTxType, bigint>>,
): Record<PointEarningsCategory, string> {
  const out = {} as Record<PointEarningsCategory, string>
  for (const key of POINT_EARNINGS_CATEGORY_KEYS) {
    let sum = 0n
    for (const txType of POINT_EARNINGS_CATEGORIES[key]) {
      sum += totalsByTxType[txType] ?? 0n
    }
    out[key] = sum.toString()
  }
  return out
}

/** Credits mapped to a category bucket (for tests / docs). */
export function categoryIncludesTxType(
  category: PointEarningsCategory,
  txType: PointTxType,
): boolean {
  return (POINT_EARNINGS_CATEGORIES[category] as readonly PointTxType[]).includes(txType)
}

/** Summary/history earnings bucket for a ledger tx type, if any. */
export function earningsCategoryForTxType(txType: PointTxType): PointEarningsCategory | null {
  for (const key of POINT_EARNINGS_CATEGORY_KEYS) {
    if (categoryIncludesTxType(key, txType)) {
      return key
    }
  }
  return null
}

export function allCategoryTxTypes(): PointTxType[] {
  return [...ALL_CATEGORY_TX_TYPES]
}
