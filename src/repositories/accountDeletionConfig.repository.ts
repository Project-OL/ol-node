import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

export const DEFAULT_GRACE_PERIOD_DAYS = 30
export const DEFAULT_DELETION_PERIOD_DAYS = 45

export const accountDeletionConfigRepository = {
  async getOrCreate() {
    return prisma.accountDeletionConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        gracePeriodDays: DEFAULT_GRACE_PERIOD_DAYS,
        deletionPeriodDays: DEFAULT_DELETION_PERIOD_DAYS,
      },
      update: {},
    })
  },

  async update(data: Prisma.AccountDeletionConfigUpdateInput) {
    return prisma.accountDeletionConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
