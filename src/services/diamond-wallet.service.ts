import { WalletCurrencyType, type CoinTxType, type Prisma } from '@prisma/client'
import { getRedisForRead, redisClient, RedisKeys, WALLET_BALANCE_TTL } from '../config/redis'
import { walletRepository } from '../repositories/wallet.repository'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { coinWalletService } from './coin-wallet.service'
import { mapDbUnavailable } from './wallet.service'
import { AppError } from '../middlewares/errorHandler'
import { singleflight } from '../utils/singleflight'
import { enrichLedgerEntries } from '../utils/ledger-transaction-enrichment'
import { GAME_DIAMOND_HISTORY_FILTER_VALUES } from '../config/game-diamond-transaction-filters'

/**
 * DIAMOND wallet — rides the existing Wallet/CoinLedgerEntry machinery (same table as
 * COIN/TRADING_COIN, scoped by `WalletCurrencyType.DIAMOND`). Debit/credit delegate to
 * `coinWalletService` so idempotency, row-locking, and insufficient-balance handling are
 * shared with every other currency on this ledger — this file only adds the DIAMOND-specific
 * balance cache and history filter.
 */
export const diamondWalletService = {
  async getBalance(userId: string): Promise<bigint> {
    const key = RedisKeys.walletDiamondBalance(userId)
    try {
      const cached = await getRedisForRead().get(key)
      if (cached !== null) return BigInt(cached)
    } catch {
      // Redis unavailable — fall through to Postgres
    }

    return singleflight(`wallet:diamond:${userId}`, async () => {
      try {
        const again = await getRedisForRead().get(key)
        if (again !== null) return BigInt(again)
      } catch {
        /* continue */
      }
      let wallet
      try {
        wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.DIAMOND)
      } catch (e) {
        mapDbUnavailable(e)
      }
      let balance: bigint
      try {
        balance = await coinLedgerRepository.computeBalance(wallet.id)
      } catch (e) {
        mapDbUnavailable(e)
      }
      try {
        await redisClient.set(key, balance.toString(), 'EX', WALLET_BALANCE_TTL)
      } catch {
        // ignore cache write failures
      }
      return balance
    })
  },

  /** Write-through after a committed ledger row. Pass the absolute post-commit balance. */
  async writeBalanceCache(userId: string, absolute: bigint) {
    try {
      await redisClient.set(
        RedisKeys.walletDiamondBalance(userId),
        absolute.toString(),
        'EX',
        WALLET_BALANCE_TTL,
      )
    } catch {
      try {
        await redisClient.del(RedisKeys.walletDiamondBalance(userId))
      } catch {
        /* ignore */
      }
    }
  },

  /** No known absolute snapshot: drop the key so the next read recomputes from Postgres. */
  async bustBalanceCache(userId: string) {
    try {
      await redisClient.del(RedisKeys.walletDiamondBalance(userId))
    } catch {
      // ignore — recomputed from Postgres on next read
    }
  },

  /** Thin passthrough so callers don't need to know diamonds ride `coinWalletService`. */
  debit(
    userId: string,
    amount: bigint,
    txType: CoinTxType,
    tx: Prisma.TransactionClient,
    options: {
      idempotencyKey: string
      description?: string
      metadata?: Prisma.JsonValue
      counterpartyId?: string
    },
  ) {
    return coinWalletService.debit(userId, amount, txType, tx, {
      ...options,
      currencyType: WalletCurrencyType.DIAMOND,
    })
  },

  credit(
    userId: string,
    amount: bigint,
    txType: CoinTxType,
    tx: Prisma.TransactionClient,
    options: {
      idempotencyKey: string
      description?: string
      metadata?: Prisma.JsonValue
      counterpartyId?: string
    },
  ) {
    return coinWalletService.credit(userId, amount, txType, tx, {
      ...options,
      applyWealthCredit: false,
      currencyType: WalletCurrencyType.DIAMOND,
    })
  },

  async getHistory(
    userId: string,
    filter: {
      types?: string[]
      from?: string
      to?: string
      cursor?: string
      limit: number
    },
  ) {
    let ledgerTypes: CoinTxType[] | undefined
    if (filter.types?.length) {
      const allowed = new Set<string>(GAME_DIAMOND_HISTORY_FILTER_VALUES)
      for (const t of filter.types) {
        if (!allowed.has(t)) {
          throw new AppError(400, `Invalid types filter: ${t}`, 'INVALID_REQUEST')
        }
      }
      ledgerTypes = filter.types as CoinTxType[]
    }

    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.DIAMOND)

    const entries = await coinLedgerRepository.list({
      walletId: wallet.id,
      types: ledgerTypes,
      from: filter.from ? new Date(filter.from) : undefined,
      to: filter.to ? new Date(filter.to) : undefined,
      cursor: filter.cursor,
      limit: filter.limit,
    })

    const hasMore = entries.length > filter.limit
    const page = hasMore ? entries.slice(0, filter.limit) : entries
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined

    const baseEntries = page.map((e) => ({
      id: e.id,
      direction: e.direction,
      txType: e.txType,
      amount: e.amount,
      balanceAfter: e.balanceAfter.toString(),
      refId: e.refId,
      counterpartyId: e.counterpartyId,
      description: e.description,
      metadata: e.metadata,
      createdAt: e.createdAt,
    }))

    const enriched = await enrichLedgerEntries(baseEntries, 'DIAMOND', userId)

    return {
      entries: enriched.map((e) => ({
        id: e.id,
        direction: e.direction,
        txType: e.txType,
        transactionName: e.transactionName,
        amount: e.amount.toString(),
        balanceAfter: e.balanceAfter,
        refId: e.refId,
        description: e.description,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
      nextCursor,
      hasMore,
    }
  },
}
