import { env } from '../config/env'
import { redisClient, RedisKeys, SUPER_HOST_STATUS_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { superHostRepository } from '../repositories/super-host.repository'
import { userRepository } from '../repositories/user.repository'
import { cacheService } from './cache.service'

function ensureAdmin(userId: string): void {
  if (!env.ADMIN_USER_IDS.includes(userId)) {
    throw new AppError(403, 'Admin only', 'FORBIDDEN')
  }
}

async function invalidateSuperHostCache(userId: string): Promise<void> {
  await cacheService.delete(RedisKeys.superHostStatus(userId))
}

export const superHostService = {
  async isSuperHost(targetUserId: string): Promise<boolean> {
    const key = RedisKeys.superHostStatus(targetUserId)
    const hit = await cacheService.get(key)
    if (hit === '1') return true
    if (hit === '0') return false

    const exists = await superHostRepository.isActive(targetUserId)
    await cacheService.set(key, exists ? '1' : '0', SUPER_HOST_STATUS_TTL)
    return exists
  },

  /**
   * Batched isSuperHost for list endpoints: one Redis pipeline for cached flags,
   * one DB query for misses, same per-user cache keys/format as the single path.
   */
  async isSuperHostBulk(userIds: string[]): Promise<Map<string, boolean>> {
    const unique = [...new Set(userIds.filter(Boolean))]
    const map = new Map<string, boolean>()
    if (unique.length === 0) return map

    let cached: (string | null)[] = new Array(unique.length).fill(null)
    try {
      const pipe = redisClient.pipeline()
      for (const id of unique) pipe.get(RedisKeys.superHostStatus(id))
      const exec = await pipe.exec()
      if (exec && exec.length === unique.length) {
        cached = exec.map(([, v]) => v as string | null)
      }
    } catch {
      // Redis unavailable — treat all as misses
    }

    const missing: string[] = []
    for (let i = 0; i < unique.length; i++) {
      const id = unique[i]!
      if (cached[i] === '1') map.set(id, true)
      else if (cached[i] === '0') map.set(id, false)
      else missing.push(id)
    }
    if (missing.length === 0) return map

    const activeSet = await superHostRepository.isActiveBulk(missing)
    try {
      const writePipe = redisClient.pipeline()
      for (const id of missing) {
        writePipe.set(
          RedisKeys.superHostStatus(id),
          activeSet.has(id) ? '1' : '0',
          'EX',
          SUPER_HOST_STATUS_TTL,
        )
      }
      await writePipe.exec()
    } catch {
      // best-effort cache write
    }
    for (const id of missing) map.set(id, activeSet.has(id))
    return map
  },

  async grantSuperHost(adminUserId: string, targetUserId: string): Promise<void> {
    ensureAdmin(adminUserId)

    const user = await userRepository.findById(targetUserId)
    if (!user) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    const alreadySuperHost = await superHostRepository.isActive(targetUserId)
    if (alreadySuperHost) {
      throw new AppError(409, 'User is already a super host', 'SUPER_HOST_ALREADY_EXISTS')
    }

    await superHostRepository.grant(targetUserId, adminUserId)
    await invalidateSuperHostCache(targetUserId)
  },

  async revokeSuperHost(adminUserId: string, targetUserId: string): Promise<void> {
    ensureAdmin(adminUserId)

    const user = await userRepository.findById(targetUserId)
    if (!user) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    const active = await superHostRepository.isActive(targetUserId)
    if (!active) {
      throw new AppError(404, 'Super host grant not found', 'SUPER_HOST_NOT_FOUND')
    }

    await superHostRepository.revoke(targetUserId, adminUserId)
    await invalidateSuperHostCache(targetUserId)
  },
}
