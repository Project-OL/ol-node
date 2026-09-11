import { env } from '../config/env'

/** Minimum TRADING_COIN balance for an agency owner to be treated as a coinseller. */
export function coinsellerMinTradingBalance(): bigint {
  return BigInt(env.COINSELLER_MIN_TRADING_BALANCE)
}

export function isCoinsellerByTradingBalance(balance: bigint | number | null | undefined): boolean {
  if (balance == null) return false
  const b = typeof balance === 'bigint' ? balance : BigInt(Math.trunc(balance))
  return b >= coinsellerMinTradingBalance()
}
