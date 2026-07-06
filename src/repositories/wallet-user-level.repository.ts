import { prisma, prismaRead } from '../config/database'
import { LevelType } from '@prisma/client'

export const walletUserLevelRepository = {
  async getOrCreate(userId: string, levelType: LevelType) {
    return prisma.walletUserLevel.upsert({
      where: { userId_levelType: { userId, levelType } },
      create: { userId, levelType, currentLevel: 1, cumulativeTotal: 0n },
      update: {},
    })
  },

  async getByUser(userId: string, levelType: LevelType) {
    return prismaRead.walletUserLevel.findUnique({
      where: { userId_levelType: { userId, levelType } },
    })
  },

  /** Multiple level rows (e.g. LIVESTREAM + WEALTH for /users/me) in one round-trip. */
  async getByUserForTypes(userId: string, levelTypes: LevelType[]) {
    return prismaRead.walletUserLevel.findMany({
      where: { userId, levelType: { in: levelTypes } },
    })
  },

  /** Level rows for many users in one round-trip (batch display enrichment). */
  async getByUsersForTypes(userIds: string[], levelTypes: LevelType[]) {
    if (userIds.length === 0) return []
    return prismaRead.walletUserLevel.findMany({
      where: { userId: { in: userIds }, levelType: { in: levelTypes } },
    })
  },

  async getConfigs(levelType: LevelType) {
    return prismaRead.walletLevelConfig.findMany({
      where: { levelType, isActive: true },
      orderBy: { level: 'asc' },
    })
  },

  async getAllConfigs() {
    return prismaRead.walletLevelConfig.findMany({
      where: { isActive: true },
      orderBy: [{ levelType: 'asc' }, { level: 'asc' }],
    })
  },
}
