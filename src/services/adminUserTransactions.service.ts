import { CoinTxType } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import {
  COIN_HISTORY_FILTER_VALUES,
  COIN_TRANSACTION_CATEGORY_KEYS,
  resolveCoinHistoryTxTypes,
} from '../config/coin-earnings-categories'
import {
  POINT_EARNINGS_CATEGORY_KEYS,
  POINT_HISTORY_FILTER_ALIASES,
  POINT_HISTORY_FILTER_VALUES,
  resolvePointHistoryTxTypes,
} from '../config/point-earnings-categories'
import { TRADING_COIN_HISTORY_FILTER_VALUES } from '../config/trading-coin-transaction-filters'
import { userRepository } from '../repositories/user.repository'
import { coinWalletService } from './coin-wallet.service'
import { pointWalletService } from './point-wallet.service'
import { coinTradingService } from './coinTrading.service'

function parseTradingTypes(filters?: string[]): CoinTxType[] | undefined {
  if (!filters?.length) return undefined
  const allowed = new Set<string>(TRADING_COIN_HISTORY_FILTER_VALUES)
  const invalid = filters.filter((f) => !allowed.has(f))
  if (invalid.length > 0) {
    throw new AppError(400, `Invalid trading coin types: ${invalid.join(', ')}`, 'INVALID_REQUEST')
  }
  return filters as CoinTxType[]
}

export const adminUserTransactionsService = {
  getFilterTypes() {
    return {
      personalCoins: {
        categories: COIN_TRANSACTION_CATEGORY_KEYS,
        filterValues: COIN_HISTORY_FILTER_VALUES,
      },
      points: {
        categories: POINT_EARNINGS_CATEGORY_KEYS,
        aliases: Object.keys(POINT_HISTORY_FILTER_ALIASES),
        filterValues: POINT_HISTORY_FILTER_VALUES,
      },
      tradingCoins: {
        filterValues: TRADING_COIN_HISTORY_FILTER_VALUES,
      },
    }
  },

  async listPersonalCoinTransactions(
    userId: string,
    filter: { types?: string[]; from?: string; to?: string; cursor?: string; limit: number },
  ) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    resolveCoinHistoryTxTypes(filter.types)
    return coinWalletService.getHistory(userId, {
      ...filter,
      alwaysIncludeUserCounterparty: true,
    })
  },

  async listPointTransactions(
    userId: string,
    filter: { types?: string[]; from?: string; to?: string; cursor?: string; limit: number },
  ) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    resolvePointHistoryTxTypes(filter.types)
    return pointWalletService.getHistory(userId, {
      ...filter,
      alwaysIncludeUserCounterparty: true,
    })
  },

  async listTradingCoinTransactions(
    userId: string,
    filter: {
      types?: string[]
      from?: string
      to?: string
      cursor?: string
      limit: number
      direction?: 'credit' | 'debit'
    },
  ) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    const types = parseTradingTypes(filter.types)
    return coinTradingService.listAdminTradingCoinHistory(userId, {
      types,
      fromDate: filter.from ? new Date(filter.from) : undefined,
      toDate: filter.to ? new Date(filter.to) : undefined,
      cursor: filter.cursor,
      limit: filter.limit,
      direction: filter.direction,
    })
  },
}
