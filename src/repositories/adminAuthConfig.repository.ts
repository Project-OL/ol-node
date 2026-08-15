import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

/** Consecutive wrong passwords that lock the admin account. */
export const DEFAULT_ADMIN_LOCKOUT_THRESHOLD = 5
/** Lock duration once the threshold is reached (minutes). 1440 = 24 hours. */
export const DEFAULT_ADMIN_LOCKOUT_MINUTES = 1440

export const adminAuthConfigRepository = {
  async getOrCreate() {
    return prisma.adminAuthConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        failedLoginThreshold: DEFAULT_ADMIN_LOCKOUT_THRESHOLD,
        lockoutMinutes: DEFAULT_ADMIN_LOCKOUT_MINUTES,
      },
      update: {},
    })
  },

  async update(data: Prisma.AdminAuthConfigUpdateInput) {
    return prisma.adminAuthConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
