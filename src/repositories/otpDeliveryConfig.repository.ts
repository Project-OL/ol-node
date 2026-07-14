import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

export const otpDeliveryConfigRepository = {
  async getOrCreate() {
    return prisma.otpDeliveryConfig.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    })
  },

  async update(data: Prisma.OtpDeliveryConfigUpdateInput) {
    return prisma.otpDeliveryConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
