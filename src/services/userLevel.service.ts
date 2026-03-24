import { RedisKeys } from '../config/redis'
import { cacheService } from './cache.service'
import { userLevelRepository } from '../repositories/userLevel.repository'
import type { UserLevel } from '@prisma/client'

export const userLevelService = {
  async getOrCreateLevel(userId: string): Promise<UserLevel> {
    const cacheKey = RedisKeys.userLevel(userId)
    const cached = await cacheService.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as UserLevel
    }
    const level = await userLevelRepository.upsertLevel(userId)
    await cacheService.set(
      cacheKey,
      JSON.stringify(level, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
      3600,
    )
    return level
  },

  async getLevelForUsers(userIds: string[]): Promise<Map<string, UserLevel>> {
    const uniqueIds = Array.from(new Set(userIds))
    const existing = await userLevelRepository.findLevelsByUserIds(uniqueIds)
    const missingIds = uniqueIds.filter((id) => !existing.has(id))
    if (missingIds.length > 0) {
      await Promise.all(missingIds.map((id) => userLevelRepository.upsertLevel(id)))
      const refreshed = await userLevelRepository.findLevelsByUserIds(uniqueIds)
      return refreshed
    }
    return existing
  },

  async recalculateLevel(userId: string, type: 'livestream' | 'wealth'): Promise<void> {
    const current = await this.getOrCreateLevel(userId)
    const configs = await userLevelRepository.findLevelConfig(type)
    if (configs.length === 0) return

    const xp = type === 'livestream' ? current.livestreamXp : current.wealthXp
    const xpNumber = BigInt(xp)
    let newLevel = type === 'livestream' ? current.livestreamLevel : current.wealthLevel

    for (const cfg of configs) {
      if (xpNumber >= cfg.minXp && xpNumber < cfg.maxXp) {
        newLevel = cfg.level
        break
      }
    }

    const storedLevel = type === 'livestream' ? current.livestreamLevel : current.wealthLevel
    if (newLevel !== storedLevel) {
      await userLevelRepository.updateLevel(userId, type, newLevel)
      await cacheService.delete(RedisKeys.userLevel(userId))
    }
  },
}

