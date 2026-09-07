import { prisma, prismaRead } from '../config/database'

export const videoCallRepository = {
  // ── Settings ──────────────────────────────────────────────────────────────

  async getSettings(userId: string) {
    return prismaRead.videoCallSettings.findUnique({ where: { userId } })
  },

  /**
   * Ensure a physical `video_call_settings` row exists (Live-server requires it
   * on initiate). Idempotent — no-op when the row is already present.
   */
  async ensureDefaults(userId: string) {
    return prisma.videoCallSettings.upsert({
      where: { userId },
      create: {
        userId,
        pricePerMin: 1800,
        blockLv5: false,
        blockLv10: false,
        acceptVideoCalls: true,
      },
      update: {},
    })
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

  /**
   * Every session still in a non-terminal state, oldest first.
   * `RINGING` is included alongside `ACTIVE`: a call that never connected is
   * exactly the kind of row the stale-session sweep exists to close.
   * Used by `src/scripts/cleanup-stale-video-call-sessions.ts`.
   */
  async findOpenSessions() {
    return prismaRead.videoCallSession.findMany({
      where: { status: { in: ['ACTIVE', 'RINGING'] } },
      orderBy: { startedAt: 'asc' },
    })
  },

  /**
   * Terminal close used by the cleanup sweep. Deliberately wider than
   * `endSession`: that one is the typed call-lifecycle path, whereas the sweep
   * also writes `MISSED` for a session that died while still `RINGING`.
   * `video_call_sessions.status` is a free `VarChar(50)`, not an enum.
   */
  async closeSession(sessionId: string, status: string, reason?: string) {
    return prisma.videoCallSession.update({
      where: { id: sessionId },
      data: { status, endedAt: new Date(), endReason: reason ?? null },
    })
  },
}
