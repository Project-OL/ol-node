import { CoinTxType } from '@prisma/client'

/** Filter values for DIAMOND ledger history (user-facing and admin explorer). */
export const GAME_DIAMOND_TX_TYPES = [
  CoinTxType.DIAMOND_PURCHASE_IN,
  CoinTxType.DIAMOND_REDEEM_OUT,
  CoinTxType.GAME_WAGER_OUT,
  CoinTxType.GAME_RESULT_IN,
  CoinTxType.GAME_REFUND_IN,
  CoinTxType.GAME_ADJUSTMENT,
] as const

export const GAME_DIAMOND_HISTORY_FILTER_VALUES = [...GAME_DIAMOND_TX_TYPES] as const
