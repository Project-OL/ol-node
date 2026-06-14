/**
 * Centralized cache for auth-related data. All cache read/write/invalidate
 * for user auth identifiers and device list goes through this service.
 */

import {
  redisClient,
  getRedisForRead,
  RedisKeys,
  AUTH_IDENTIFIERS_CACHE_TTL,
  USER_DEVICES_CACHE_TTL,
} from '../config/redis'
import { redisCircuitBreaker } from '../utils/circuitBreaker'

export interface CachedAuthIdentifier {
  provider: string
  identifier: string
  isVerified: boolean
  verifiedAt: string | null
  isPrimary: boolean
}

export const cacheService = {
  /**
   * Get cached user auth identifiers (JSON string or null).
   */
  async getUserAuthIdentifiers(userId: string): Promise<string | null> {
    if (redisCircuitBreaker.shouldSkip()) return null
    try {
      const val = await getRedisForRead().get(RedisKeys.userAuthIdentifiers(userId))
      redisCircuitBreaker.recordSuccess()
      return val
    } catch {
      redisCircuitBreaker.recordFailure()
      return null
    }
  },

  /**
   * Set user auth identifiers cache with TTL (default 1 hour).
   */
  async setUserAuthIdentifiers(
    userId: string,
    data: CachedAuthIdentifier[],
    ttlSeconds: number = AUTH_IDENTIFIERS_CACHE_TTL,
  ): Promise<void> {
    const key = RedisKeys.userAuthIdentifiers(userId)
    await redisClient.set(key, JSON.stringify(data), 'EX', ttlSeconds)
  },

  /**
   * Invalidate user auth identifiers cache (call after any identifier bind/modify/unbind).
   */
  async invalidateUserAuthIdentifiers(userId: string): Promise<void> {
    await redisClient.del(RedisKeys.userAuthIdentifiers(userId))
    await redisClient.del(RedisKeys.userSecurityIdentifiers(userId))
  },

  /**
   * Generic get (for device list etc.). Uses read client when REDIS_READ_URL set. Returns null when circuit open.
   */
  async get(key: string): Promise<string | null> {
    if (redisCircuitBreaker.shouldSkip()) return null
    try {
      const val = await getRedisForRead().get(key)
      redisCircuitBreaker.recordSuccess()
      return val
    } catch {
      redisCircuitBreaker.recordFailure()
      return null
    }
  },

  /**
   * Generic set with TTL in seconds.
   */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await redisClient.set(key, value, 'EX', ttlSeconds)
  },

  /**
   * Generic delete.
   */
  async delete(key: string): Promise<void> {
    await redisClient.del(key)
  },

  /**
   * Get cached user devices list (JSON string or null).
   */
  async getUserDevices(userId: string): Promise<string | null> {
    if (redisCircuitBreaker.shouldSkip()) return null
    try {
      const val = await getRedisForRead().get(RedisKeys.userDevices(userId))
      redisCircuitBreaker.recordSuccess()
      return val
    } catch {
      redisCircuitBreaker.recordFailure()
      return null
    }
  },

  /**
   * Set user devices cache (TTL 5 min).
   */
  async setUserDevices(userId: string, data: string): Promise<void> {
    await redisClient.set(RedisKeys.userDevices(userId), data, 'EX', USER_DEVICES_CACHE_TTL)
  },

  /**
   * Invalidate user devices and sessions caches (e.g. after revoke, rename, logout-all).
   */
  async invalidateUserDevicesAndSessions(userId: string): Promise<void> {
    await redisClient.del(RedisKeys.userDevices(userId))
    await redisClient.del(RedisKeys.userSessions(userId))
  },
}
