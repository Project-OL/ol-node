import { CoinTxType, PointTxType, WalletCurrencyType } from '@prisma/client'
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
import { GAME_DIAMOND_HISTORY_FILTER_VALUES } from '../config/game-diamond-transaction-filters'
import { userRepository } from '../repositories/user.repository'
import { coinTradingRepository } from '../repositories/coinTrading.repository'
import { coinWalletService } from './coin-wallet.service'
import { pointWalletService } from './point-wallet.service'
import { diamondWalletService } from './diamond-wallet.service'
import { coinTradingService } from './coinTrading.service'
import {
  resolveCoinLedgerRevertability,
  resolvePointLedgerRevertability,
} from './adminTransactions.service'
import {
  ADMIN_WITHDRAWAL_LEDGER_TX_TYPES,
  isAdminWithdrawalRevertable,
} from '../utils/admin-withdrawal-revert'
import { prismaRead } from '../config/database'
import type { AdminCoinRevertVia } from './adminTransactions.service'

function parseTradingTypes(filters?: string[]): CoinTxType[] | undefined {
  if (!filters?.length) return undefined
  const allowed = new Set<string>(TRADING_COIN_HISTORY_FILTER_VALUES)
  const invalid = filters.filter((f) => !allowed.has(f))
  if (invalid.length > 0) {
    throw new AppError(400, `Invalid trading coin types: ${invalid.join(', ')}`, 'INVALID_REQUEST')
  }
  return filters as CoinTxType[]
}

type HistoryRow = {
  id: string
  counterpartyId?: string | null
  transferId?: string | null
  [key: string]: unknown
}

async function attachCoinRevertFlags<T extends HistoryRow>(
  rows: T[],
  currencyType: WalletCurrencyType,
): Promise<
  Array<
    T & {
      canRevert: boolean
      revertVia: ReturnType<typeof resolveCoinLedgerRevertability>['revertVia']
    }
  >
> {
  if (rows.length === 0) {
    return rows.map((r) => ({ ...r, canRevert: false as const, revertVia: null }))
  }

  const transfers = await coinTradingRepository.findTransfersByLedgerEntryIds(rows.map((r) => r.id))
  const transferByLedger = new Map<string, (typeof transfers)[number]>()
  for (const t of transfers) {
    transferByLedger.set(t.senderLedgerEntryId, t)
    transferByLedger.set(t.recipientLedgerEntryId, t)
  }

  return rows.map((row) => {
    const linked = transferByLedger.get(row.id)
    const fromTopLevel =
      typeof row.transferId === 'string' && row.transferId
        ? { id: row.transferId, reversedAt: linked?.reversedAt ?? null }
        : null
    const tradingTransfer = linked ? { id: linked.id, reversedAt: linked.reversedAt } : fromTopLevel

    const { canRevert, revertVia } = resolveCoinLedgerRevertability({
      currencyType,
      ledgerEntryId: row.id,
      counterpartyId: typeof row.counterpartyId === 'string' ? row.counterpartyId : null,
      tradingTransfer,
    })

    return {
      ...row,
      canRevert,
      revertVia,
      // Keep nested shape admin UI already normalizes.
      coinTradingTransfer: tradingTransfer
        ? {
            id: tradingTransfer.id,
            reversedAt: tradingTransfer.reversedAt?.toISOString?.() ?? tradingTransfer.reversedAt,
          }
        : ((row as { coinTradingTransfer?: unknown }).coinTradingTransfer ?? null),
    }
  })
}

async function attachPointRevertFlags<
  T extends HistoryRow & { txType?: string; refId?: string | null },
>(rows: T[]): Promise<Array<T & { canRevert: boolean; revertVia: AdminCoinRevertVia | null }>> {
  const withdrawalIds = [
    ...new Set(
      rows
        .filter(
          (r) =>
            r.txType &&
            ADMIN_WITHDRAWAL_LEDGER_TX_TYPES.has(r.txType as PointTxType) &&
            typeof r.refId === 'string' &&
            r.refId,
        )
        .map((r) => r.refId as string),
    ),
  ]
  const withdrawals =
    withdrawalIds.length > 0
      ? await prismaRead.withdrawal.findMany({
          where: { id: { in: withdrawalIds } },
          select: { id: true, status: true, processedAt: true },
        })
      : []
  const withdrawalMap = new Map(withdrawals.map((w) => [w.id, w]))

  return rows.map((row) => {
    const withdrawal =
      row.txType &&
      ADMIN_WITHDRAWAL_LEDGER_TX_TYPES.has(row.txType as PointTxType) &&
      typeof row.refId === 'string'
        ? withdrawalMap.get(row.refId)
        : undefined
    if (
      withdrawal &&
      isAdminWithdrawalRevertable({
        status: withdrawal.status,
        processedAt: withdrawal.processedAt,
      })
    ) {
      return {
        ...row,
        canRevert: true,
        revertVia: { endpoint: 'withdrawal', id: withdrawal.id },
      }
    }
    return {
      ...row,
      canRevert: resolvePointLedgerRevertability({
        txType: row.txType as PointTxType,
        counterpartyId: typeof row.counterpartyId === 'string' ? row.counterpartyId : null,
      }),
      revertVia: null,
    }
  })
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
      diamonds: {
        filterValues: GAME_DIAMOND_HISTORY_FILTER_VALUES,
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
    const history = await coinWalletService.getHistory(userId, {
      ...filter,
      alwaysIncludeUserCounterparty: true,
    })
    return {
      ...history,
      entries: await attachCoinRevertFlags(history.entries ?? [], WalletCurrencyType.COIN),
    }
  },

  async listPointTransactions(
    userId: string,
    filter: { types?: string[]; from?: string; to?: string; cursor?: string; limit: number },
  ) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    resolvePointHistoryTxTypes(filter.types)
    const history = await pointWalletService.getHistory(userId, {
      ...filter,
      alwaysIncludeUserCounterparty: true,
    })
    return {
      ...history,
      entries: await attachPointRevertFlags(history.entries ?? []),
    }
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
    const history = await coinTradingService.listAdminTradingCoinHistory(userId, {
      types,
      fromDate: filter.from ? new Date(filter.from) : undefined,
      toDate: filter.to ? new Date(filter.to) : undefined,
      cursor: filter.cursor,
      limit: filter.limit,
      direction: filter.direction,
    })
    const items = await attachCoinRevertFlags(
      (history.items ?? []) as HistoryRow[],
      WalletCurrencyType.TRADING_COIN,
    )
    return {
      ...history,
      items,
      // Explorer-shaped alias so admin clients can use either key.
      entries: items,
    }
  },

  /**
   * DIAMOND ledger history for one user — game wagers/results/refunds plus
   * Coin↔Diamond conversions and admin adjustments.
   *
   * Deliberately NOT revertable: every game row is one leg of a double-entry pair
   * settled against the GAME_HOUSE account and anchored on BAISHUN's `order_id`
   * (`game_round_ledger_links`). Reverting a single leg would break both the
   * pairing and the idempotency anchor BAISHUN retries against. Correct a
   * diamond balance with an admin adjustment (`POST /admin/currency/adjust`,
   * currency DIAMOND) instead, which writes its own `GAME_ADJUSTMENT` row.
   */
  async listDiamondTransactions(
    userId: string,
    filter: { types?: string[]; from?: string; to?: string; cursor?: string; limit: number },
  ) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    const history = await diamondWalletService.getHistory(userId, filter)
    return {
      ...history,
      entries: (history.entries ?? []).map((entry) => ({
        ...entry,
        canRevert: false as const,
        revertVia: null,
      })),
    }
  },
}
