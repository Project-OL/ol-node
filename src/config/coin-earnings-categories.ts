import { CoinTxType } from '@prisma/client'

/** UI / API buckets for personal COIN wallet history filters. */
export const COIN_TRANSACTION_CATEGORIES = {
  topup: [CoinTxType.TRADING_TRANSFER_IN, CoinTxType.TOPUP, CoinTxType.ADJUSTMENT],
  gift: [CoinTxType.GIFT_SEND],
  platform_reward: [CoinTxType.VIP_REWARD],
  others: [
    CoinTxType.POINT_EXCHANGE_TO_COINS,
    CoinTxType.VIDEO_CALL,
    CoinTxType.CREATOR_SUBSCRIPTION,
    CoinTxType.GUARDIAN_PURCHASE,
    CoinTxType.STORE_ITEM_PURCHASE,
    CoinTxType.VIP_PURCHASE,
    CoinTxType.VIP_MEMBERSHIP_PURCHASE,
    CoinTxType.USERNAME_CHANGE,
  ],
} as const satisfies Record<string, CoinTxType[]>

export type CoinTransactionCategory = keyof typeof COIN_TRANSACTION_CATEGORIES

export const COIN_TRANSACTION_CATEGORY_KEYS = Object.keys(
  COIN_TRANSACTION_CATEGORIES,
) as CoinTransactionCategory[]

const CATEGORY_SET = new Set<string>(COIN_TRANSACTION_CATEGORY_KEYS)

const ALL_CATEGORY_TX_TYPES = new Set<CoinTxType>(Object.values(COIN_TRANSACTION_CATEGORIES).flat())

/** Raw ledger types allowed in `types` query (categories + individual tx types). */
export const COIN_HISTORY_FILTER_VALUES = [
  ...COIN_TRANSACTION_CATEGORY_KEYS,
  ...Object.values(CoinTxType),
] as const

export type CoinHistoryFilterValue = (typeof COIN_HISTORY_FILTER_VALUES)[number]

export function isCoinTransactionCategory(value: string): value is CoinTransactionCategory {
  return CATEGORY_SET.has(value)
}

/**
 * Expand history `types` query values (category aliases and/or raw CoinTxType) to ledger types.
 */
export function resolveCoinHistoryTxTypes(filters?: string[]): CoinTxType[] | undefined {
  if (!filters?.length) return undefined

  const resolved = new Set<CoinTxType>()
  const invalid: string[] = []

  for (const raw of filters) {
    if (isCoinTransactionCategory(raw)) {
      for (const t of COIN_TRANSACTION_CATEGORIES[raw]) {
        resolved.add(t)
      }
      continue
    }
    if ((Object.values(CoinTxType) as string[]).includes(raw)) {
      resolved.add(raw as CoinTxType)
      continue
    }
    invalid.push(raw)
  }

  if (invalid.length > 0) {
    throw new Error(`Invalid coin history type filter: ${invalid.join(', ')}`)
  }

  return resolved.size > 0 ? [...resolved] : undefined
}

export function allCoinCategoryTxTypes(): CoinTxType[] {
  return [...ALL_CATEGORY_TX_TYPES]
}
