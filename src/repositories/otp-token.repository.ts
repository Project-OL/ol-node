import { prisma } from '../config/database'
import type { OtpPurpose } from '../models/types'
import { normalizeIdentifierGuess } from '../utils/auth-identifier'

/**
 * `target_identifier` is matched exactly on verify, so an OTP requested for `Abcd@x.com` must be
 * findable when verified as `abcd@x.com`. Both sides are normalised here (emails lower-cased,
 * everything else trimmed) — the delivery layer already lower-cases the address it sends to.
 */
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
        targetIdentifier: normalizeIdentifierGuess(data.targetIdentifier),
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
      targetIdentifier: normalizeIdentifierGuess(targetIdentifier),
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
