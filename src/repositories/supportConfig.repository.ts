import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

/** Default PENDING_REVIEW contest window: 24 hours. */
export const DEFAULT_SUPPORT_REVIEW_WINDOW_MS = 24 * 3_600_000

export const supportConfigRepository = {
  async getOrCreate() {
    return prisma.supportConfig.upsert({
      where: { id: 1 },
      create: { id: 1, reviewWindowMs: DEFAULT_SUPPORT_REVIEW_WINDOW_MS },
      update: {},
    })
  },

  async update(data: Prisma.SupportConfigUpdateInput) {
    return prisma.supportConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
