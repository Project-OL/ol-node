import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

/** Default shared edit/delete window: 1 hour (legacy hard-coded value). */
export const DEFAULT_MESSAGE_ACTION_WINDOW_MS = 60 * 60 * 1000

export const messagingConfigRepository = {
  async getOrCreate() {
    return prisma.messagingConfig.upsert({
      where: { id: 1 },
      create: { id: 1, actionWindowMs: DEFAULT_MESSAGE_ACTION_WINDOW_MS },
      update: {},
    })
  },

  async update(data: Prisma.MessagingConfigUpdateInput) {
    return prisma.messagingConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
