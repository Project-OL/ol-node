import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { env } from '../config/env'

export const faceLivenessConfigRepository = {
  async getOrCreate() {
    return prisma.faceLivenessConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        livenessRequired: env.FACE_LIVENESS_REQUIRED,
        credentialsRequired: env.FACE_LIVENESS_CREDENTIALS_REQUIRED,
      },
      update: {},
    })
  },

  async update(data: Prisma.FaceLivenessConfigUpdateInput) {
    return prisma.faceLivenessConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
