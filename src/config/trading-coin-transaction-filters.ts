import { CoinTxType } from '@prisma/client'

/** Filter values for admin TRADING_COIN ledger history. */
export const TRADING_COIN_TX_TYPES = [
  CoinTxType.TRADING_TOPUP,
  CoinTxType.TRADING_EXCHANGE_FROM_POINTS,
  CoinTxType.TRADING_TRANSFER_IN,
  CoinTxType.TRADING_TRANSFER_OUT,
  CoinTxType.TRADING_TRANSFER_REVERSAL,
  CoinTxType.ADJUSTMENT,
] as const

export const TRADING_COIN_HISTORY_FILTER_VALUES = [...TRADING_COIN_TX_TYPES] as const
