import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

/** Hours a host must wait after leaving or a rejected join before applying again. */
export const DEFAULT_REJOIN_COOLDOWN_HOURS = 24

export const agencyHostConfigRepository = {
  async getOrCreate() {
    return prisma.agencyHostConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        rejoinCooldownHours: DEFAULT_REJOIN_COOLDOWN_HOURS,
      },
      update: {},
    })
  },

  async update(data: Prisma.AgencyHostConfigUpdateInput) {
    return prisma.agencyHostConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
