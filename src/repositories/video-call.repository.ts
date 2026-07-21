import { prisma, prismaRead } from '../config/database'

export const videoCallRepository = {
  // ── Settings ──────────────────────────────────────────────────────────────

  async getSettings(userId: string) {
    return prismaRead.videoCallSettings.findUnique({ where: { userId } })
  },

  async upsertSettings(
    userId: string,
    data: {
      pricePerMin?: number
      blockLv5?: boolean
      blockLv10?: boolean
      acceptVideoCalls?: boolean
    },
  ) {
    return prisma.videoCallSettings.upsert({
      where: { userId },
      create: {
        userId,
        pricePerMin: data.pricePerMin ?? 1800,
        blockLv5: data.blockLv5 ?? false,
        blockLv10: data.blockLv10 ?? false,
        acceptVideoCalls: data.acceptVideoCalls ?? true,
      },
      update: data,
    })
  },

  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(data: {
    callerId: string
    creatorId: string
    livekitRoom: string
    pricePerMin: number
  }) {
    return prisma.videoCallSession.create({ data })
  },

  async getSession(sessionId: string) {
    return prismaRead.videoCallSession.findUnique({ where: { id: sessionId } })
  },

  async getActiveSessionBetween(callerId: string, creatorId: string) {
    return prismaRead.videoCallSession.findFirst({
      where: { callerId, creatorId, status: 'ACTIVE' },
    })
  },

  async incrementMinute(sessionId: string, coinsDeducted: bigint, pointsAwarded: bigint) {
    return prisma.videoCallSession.update({
      where: { id: sessionId },
      data: {
        minsCharged: { increment: 1 },
        coinsDeducted: { increment: coinsDeducted },
        pointsAwarded: { increment: pointsAwarded },
      },
    })
  },

  async endSession(sessionId: string, status: 'ENDED' | 'INSUFFICIENT_COINS', reason?: string) {
    return prisma.videoCallSession.update({
      where: { id: sessionId },
      data: { status, endedAt: new Date(), endReason: reason ?? null },
    })
  },
}
