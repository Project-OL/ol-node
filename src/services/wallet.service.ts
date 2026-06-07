import { PrismaClientInitializationError } from '@prisma/client/runtime/library'
import { redisClient, getRedisForRead } from '../config/redis'
import { walletRepository } from '../repositories/wallet.repository'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { pointLedgerRepository } from '../repositories/point-ledger.repository'
import { WALLET_BALANCE_TTL, WALLET_IDEM_TTL, RedisKeys } from '../config/redis'
import { WalletCurrencyType } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'

function mapDbUnavailable(err: unknown): never {
  if (err instanceof PrismaClientInitializationError) {
    throw new AppError(
      503,
      'Database temporarily unavailable. Try again shortly.',
      'DATABASE_UNAVAILABLE',
    )
  }
  throw err
}

// redisIncrByBalance removed — balance cache is now invalidated on every mutation
// rather than incremented. Rationale: INCRBY is not safe when the cache can be
// concurrently repopulated from the DB between a write and the cache adjustment,
// leading to double-counting. Invalidation forces the next read to recompute the
// correct balance from the ledger sum (single authoritative source of truth).

export const walletService = {
  async getCoinBalance(userId: string): Promise<bigint> {
    const key = RedisKeys.walletCoinBalance(userId)
    try {
      const redis = getRedisForRead()
      const cached = await redis.get(key)
      if (cached !== null) return BigInt(cached)
    } catch {
      // Redis unavailable — fall through to Postgres
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
  },

  async getPointBalance(userId: string): Promise<bigint> {
    const key = RedisKeys.walletPointBalance(userId)
    try {
      const redis = getRedisForRead()
      const cached = await redis.get(key)
      if (cached !== null) return BigInt(cached)
    } catch {
      // Redis unavailable — fall through to Postgres
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
  },

  async adjustCoinBalanceCache(userId: string, _delta: bigint) {
    // Invalidate rather than increment: the next getCoinBalance call will recompute
    // the exact balance from the ledger, eliminating the stale-cache race where two
    // concurrent credits could INCRBY on top of an already-refreshed cache value.
    try {
      await redisClient.del(RedisKeys.walletCoinBalance(userId))
    } catch {
      // ignore — balance will be recomputed from Postgres on next read
    }
  },

  async adjustPointBalanceCache(userId: string, _delta: bigint) {
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
