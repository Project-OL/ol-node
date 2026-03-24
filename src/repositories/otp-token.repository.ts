import { prisma } from '../config/database'
import type { OtpPurpose } from '../models/types'

export const otpTokenRepository = {
  async create(data: {
    userId?: string | null
    otpHash: string
    otpPurpose: OtpPurpose
    targetIdentifier: string
    expiresAt: Date
  }) {
    return prisma.otpToken.create({
      data: {
        userId: data.userId ?? undefined,
        otpHash: data.otpHash,
        otpPurpose: data.otpPurpose,
        targetIdentifier: data.targetIdentifier,
        expiresAt: data.expiresAt,
      },
    })
  },

  async findValid(targetIdentifier: string, purpose: OtpPurpose, userId?: string | null) {
    const now = new Date()
    const where: {
      targetIdentifier: string
      otpPurpose: OtpPurpose
      isUsed: false
      expiresAt: { gt: Date }
      userId?: string | null
    } = {
      targetIdentifier,
      otpPurpose: purpose,
      isUsed: false,
      expiresAt: { gt: now },
    }
    if (userId !== undefined) where.userId = userId
    return prisma.otpToken.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
    })
  },

  async markUsed(id: string) {
    return prisma.otpToken.update({
      where: { id },
      data: { isUsed: true, verifiedAt: new Date() },
    })
  },

  async incrementAttempt(id: string) {
    return prisma.otpToken.update({
      where: { id },
      data: { attemptCount: { increment: 1 } },
    })
  },
}
