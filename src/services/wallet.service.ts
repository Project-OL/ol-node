import { PrismaClientInitializationError } from '@prisma/client/runtime/library'
import { getRedisForRead, redisClient } from '../config/redis'
import { walletRepository } from '../repositories/wallet.repository'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { pointLedgerRepository } from '../repositories/point-ledger.repository'
import { WALLET_BALANCE_TTL, WALLET_IDEM_TTL, RedisKeys } from '../config/redis'
import { WalletCurrencyType } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import { singleflight } from '../utils/singleflight'

export function mapDbUnavailable(err: unknown): never {
  if (err instanceof PrismaClientInitializationError) {
    throw new AppError(
      503,
      'Database temporarily unavailable. Try again shortly.',
      'DATABASE_UNAVAILABLE',
    )
  }
  throw err
}

// Balance cache: write-through the committed ledger `balanceAfter` when known.
// INCRBY is unsafe (double-count if a reader repopulates from DB mid-flight).
// DEL remains the fallback when the caller has no absolute snapshot.

export const walletService = {
  async getCoinBalance(userId: string): Promise<bigint> {
    const key = RedisKeys.walletCoinBalance(userId)
    try {
      const cached = await getRedisForRead().get(key)
      if (cached !== null) return BigInt(cached)
    } catch {
      // Redis unavailable — fall through to Postgres
    }

    return singleflight(`wallet:coin:${userId}`, async () => {
      try {
        const again = await getRedisForRead().get(key)
        if (again !== null) return BigInt(again)
      } catch {
        /* continue */
      }
      let wallet
      try {
        wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.COIN)
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

  async getPointBalance(userId: string): Promise<bigint> {
    const key = RedisKeys.walletPointBalance(userId)
    try {
      const cached = await getRedisForRead().get(key)
      if (cached !== null) return BigInt(cached)
    } catch {
      // Redis unavailable — fall through to Postgres
    }

    return singleflight(`wallet:point:${userId}`, async () => {
      try {
        const again = await getRedisForRead().get(key)
        if (again !== null) return BigInt(again)
      } catch {
        /* continue */
      }
      let wallet
      try {
        wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)
      } catch (e) {
        mapDbUnavailable(e)
      }
      let balance: bigint
      try {
        balance = await pointLedgerRepository.computeBalance(wallet.id)
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

  /**
   * Write-through after a committed ledger row. Pass the absolute `balanceAfter`.
   * Callers that only know a delta should omit `absolute` (falls back to DEL).
   */
  async writeCoinBalanceCache(userId: string, absolute: bigint) {
    try {
      await redisClient.set(
        RedisKeys.walletCoinBalance(userId),
        absolute.toString(),
        'EX',
        WALLET_BALANCE_TTL,
      )
    } catch {
      try {
        await redisClient.del(RedisKeys.walletCoinBalance(userId))
      } catch {
        /* ignore */
      }
    }
  },

  async writePointBalanceCache(userId: string, absolute: bigint) {
    try {
      await redisClient.set(
        RedisKeys.walletPointBalance(userId),
        absolute.toString(),
        'EX',
        WALLET_BALANCE_TTL,
      )
    } catch {
      try {
        await redisClient.del(RedisKeys.walletPointBalance(userId))
      } catch {
        /* ignore */
      }
    }
  },

  async adjustCoinBalanceCache(userId: string, _delta: bigint, absolute?: bigint) {
    if (absolute !== undefined) {
      await this.writeCoinBalanceCache(userId, absolute)
      return
    }
    // No known post-commit snapshot: drop the key so the next read recomputes.
    try {
      await redisClient.del(RedisKeys.walletCoinBalance(userId))
    } catch {
      // ignore — balance will be recomputed from Postgres on next read
    }
  },

  async adjustPointBalanceCache(userId: string, _delta: bigint, absolute?: bigint) {
    if (absolute !== undefined) {
      await this.writePointBalanceCache(userId, absolute)
      return
    }
    try {
      await redisClient.del(RedisKeys.walletPointBalance(userId))
    } catch {
      // ignore
    }
  },

  /** Invalidate the cached unconfirmed (in-flight escrow) points for a user. */
  async bustUnconfirmedCache(userId: string) {
    try {
      await redisClient.del(RedisKeys.walletPointsUnconfirmed(userId))
    } catch {
      // ignore — recomputed from Postgres on next read
    }
  },

  async adjustTradingBalanceCache(userId: string) {
    try {
      await redisClient.del(RedisKeys.ctBalance(userId))
    } catch {
      // ignore
    }
  },

  async acquireIdemKey(key: string): Promise<boolean> {
    const redisKey = RedisKeys.walletIdem(key)
    const result = await redisClient.set(redisKey, 'processing', 'EX', WALLET_IDEM_TTL, 'NX')
    return result === 'OK'
  },

  async resolveIdemKey(key: string, responseSnapshot: object) {
    const redisKey = RedisKeys.walletIdem(key)
    await redisClient.set(redisKey, JSON.stringify(responseSnapshot), 'EX', WALLET_IDEM_TTL)
  },

  async getCachedIdemResponse(key: string): Promise<object | null> {
    const redisKey = RedisKeys.walletIdem(key)
    const val = await redisClient.get(redisKey)
    if (!val || val === 'processing') return null
    try {
      return JSON.parse(val) as object
    } catch {
      return null
    }
  },
}
