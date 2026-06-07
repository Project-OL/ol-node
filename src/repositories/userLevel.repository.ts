import { prisma, prismaRead } from '../config/database'
import type { LevelConfig, UserLevel } from '@prisma/client'

export const userLevelRepository = {
  async upsertLevel(userId: string): Promise<UserLevel> {
    return prisma.userLevel.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
      },
    })
  },

  async findLevelsByUserIds(userIds: string[]): Promise<Map<string, UserLevel>> {
    if (userIds.length === 0) {
      return new Map()
    }
    const rows = await prismaRead.userLevel.findMany({
      where: { userId: { in: userIds } },
    })
    const map = new Map<string, UserLevel>()
    for (const row of rows) {
      map.set(row.userId, row)
    }
    return map
  },

  async updateXp(
    userId: string,
    type: 'livestream' | 'wealth',
    xpDelta: bigint,
  ): Promise<UserLevel> {
    const data =
      type === 'livestream'
        ? { livestreamXp: { increment: xpDelta } }
        : { wealthXp: { increment: xpDelta } }
    return prisma.userLevel.update({
      where: { userId },
      data,
    })
  },

  async updateLevel(
    userId: string,
    type: 'livestream' | 'wealth',
    newLevel: number,
  ): Promise<void> {
    const data = type === 'livestream' ? { livestreamLevel: newLevel } : { wealthLevel: newLevel }
    await prisma.userLevel.update({
      where: { userId },
      data,
    })
  },

  async findLevelConfig(type: string): Promise<LevelConfig[]> {
    return prismaRead.levelConfig.findMany({
      where: { levelType: type },
      orderBy: { level: 'asc' },
    })
  },
}
