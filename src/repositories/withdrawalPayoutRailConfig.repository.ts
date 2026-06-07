import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

export const withdrawalPayoutRailConfigRepository = {
  async getOrCreate() {
    return prisma.withdrawalPayoutRailConfig.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    })
  },

  async update(data: Prisma.WithdrawalPayoutRailConfigUpdateInput) {
    return prisma.withdrawalPayoutRailConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
