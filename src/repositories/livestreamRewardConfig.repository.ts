import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

export const DEFAULT_LIVESTREAM_REWARD_WINDOW_DAYS = 7
export const DEFAULT_LIVESTREAM_REWARD_POINTS_PER_HOUR = 2500

export const livestreamRewardConfigRepository = {
  async getOrCreate() {
    return prisma.livestreamRewardConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        windowDays: DEFAULT_LIVESTREAM_REWARD_WINDOW_DAYS,
        pointsPerHour: DEFAULT_LIVESTREAM_REWARD_POINTS_PER_HOUR,
      },
      update: {},
    })
  },

  async update(data: Prisma.LivestreamRewardConfigUpdateInput) {
    return prisma.livestreamRewardConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
