import { FastifyRequest, FastifyReply } from 'fastify'
import { getRedisForRead, RedisKeys } from '../config/redis'
import { redisCircuitBreaker } from '../utils/circuitBreaker'
import { AppError } from './errorHandler'

const JTI_NOT_BLACKLISTED_TTL_MS = 60_000
const JTI_CACHE_MAX_SIZE = 10_000
const jtiNotBlacklistedCache = new Map<string, number>()

function evictJtiCacheIfNeeded(): void {
  if (jtiNotBlacklistedCache.size < JTI_CACHE_MAX_SIZE) return
  const now = Date.now()
  for (const [jti, validUntil] of jtiNotBlacklistedCache) {
    if (validUntil <= now) jtiNotBlacklistedCache.delete(jti)
  }
  if (jtiNotBlacklistedCache.size >= JTI_CACHE_MAX_SIZE) {
    jtiNotBlacklistedCache.clear()
  }
}

/** Call when blacklisting a token (e.g. logout) so the next request checks Redis. */
export function invalidateJtiCache(jti: string): void {
  jtiNotBlacklistedCache.delete(jti)
}

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string
    jti?: string
    deviceId?: string
  }
}

export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  try {
    await request.jwtVerify()
  } catch {
    throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
  }

  const payload = request.user as { userId?: string; jti?: string; deviceId?: string }
  if (!payload?.userId) {
    throw new AppError(401, 'Invalid token', 'INVALID_TOKEN')
  }

  if (payload.jti) {
    const cached = jtiNotBlacklistedCache.get(payload.jti)
    const now = Date.now()
    if (cached != null && cached > now) {
      request.userId = payload.userId
      request.jti = payload.jti
      request.deviceId = payload.deviceId
      return
    }
    if (redisCircuitBreaker.shouldSkip()) {
      request.userId = payload.userId
      request.jti = payload.jti
      request.deviceId = payload.deviceId
      return
    }
    try {
      const redis = getRedisForRead()
      const blacklisted = await redis.get(RedisKeys.blacklist(payload.jti))
      redisCircuitBreaker.recordSuccess()
      if (blacklisted) {
        throw new AppError(401, 'Token revoked', 'TOKEN_REVOKED')
      }
    } catch (err) {
      if (err instanceof AppError) throw err
      redisCircuitBreaker.recordFailure()
      request.userId = payload.userId
      request.jti = payload.jti
      request.deviceId = payload.deviceId
      return
    }
    evictJtiCacheIfNeeded()
    jtiNotBlacklistedCache.set(payload.jti, now + JTI_NOT_BLACKLISTED_TTL_MS)
  }

  request.userId = payload.userId
  request.jti = payload.jti
  request.deviceId = payload.deviceId
}
