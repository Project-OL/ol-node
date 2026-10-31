import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

export const normalHostBasicRewardConfigRepository = {
  /** Column defaults are the defaults: off, 60 minutes, 800 points. */
  async getOrCreate() {
    return prisma.normalHostBasicRewardConfig.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    })
  },

  async update(data: Prisma.NormalHostBasicRewardConfigUpdateInput) {
    return prisma.normalHostBasicRewardConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
