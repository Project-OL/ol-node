import { env } from '../config/env'
import { RedisKeys, SUPER_HOST_STATUS_TTL } from '../config/redis'
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
