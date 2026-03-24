import { prisma, prismaRead } from '../config/database'

const MAX_SESSIONS_PER_USER = 3

export const sessionRepository = {
  async create(data: {
    id?: string
    userId: string
    deviceName: string
    deviceId: string
    deviceFingerprint?: string | null
    refreshTokenHash: string
    ipAddress: string
    userAgent?: string | null
    expiresAt: Date
    loginType?: string | null
  }) {
    return prisma.session.create({
      data: {
        ...(data.id != null && { id: data.id }),
        userId: data.userId,
        deviceName: data.deviceName,
        deviceId: data.deviceId,
        deviceFingerprint: data.deviceFingerprint ?? undefined,
        refreshTokenHash: data.refreshTokenHash,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent ?? undefined,
        expiresAt: data.expiresAt,
        loginType: data.loginType ?? undefined,
      },
    })
  },

  async findByRefreshTokenHash(refreshTokenHash: string) {
    return prismaRead.session.findFirst({
      where: { refreshTokenHash, isActive: true, isRevoked: false },
      include: { user: true },
    })
  },

  async findById(id: string) {
    return prismaRead.session.findUnique({
      where: { id },
      include: { user: true },
    })
  },

  async findActiveByUserId(userId: string) {
    return prismaRead.session.findMany({
      where: {
        userId,
        isActive: true,
        isRevoked: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastActiveAt: 'desc' },
    })
  },

  /** Active session for this user on this device (for device revoke). */
  async findActiveByUserIdAndDeviceId(
    userId: string,
    deviceId: string,
  ): Promise<{ id: string; deviceId: string; deviceName: string; lastActiveAt: Date } | null> {
    return prismaRead.session.findFirst({
      where: { userId, deviceId, isActive: true, isRevoked: false },
      select: { id: true, deviceId: true, deviceName: true, lastActiveAt: true },
    })
  },

  async countActiveByUserId(userId: string): Promise<number> {
    return prismaRead.session.count({
      where: { userId, isActive: true, isRevoked: false },
    })
  },

  async revokeByUserAndDevice(userId: string, deviceId: string): Promise<string[]> {
    const sessions = await prismaRead.session.findMany({
      where: {
        userId,
        deviceId,
        isActive: true,
        isRevoked: false,
      },
      select: { id: true },
    })
    if (sessions.length === 0) {
      return []
    }
    const ids = sessions.map((s) => s.id)
    await prisma.session.updateMany({
      where: { id: { in: ids } },
      data: { isActive: false, isRevoked: true, revokedAt: new Date() },
    })
    return ids
  },

  async revokeById(id: string) {
    return prisma.session.update({
      where: { id },
      data: { isActive: false, isRevoked: true, revokedAt: new Date() },
    })
  },

  async revokeAllByUserId(userId: string) {
    return prisma.session.updateMany({
      where: { userId },
      data: { isActive: false, isRevoked: true, revokedAt: new Date() },
    })
  },

  async updateLastActive(id: string) {
    return prisma.session.update({
      where: { id },
      data: { lastActiveAt: new Date() },
    })
  },

  async deleteOldestSessionsIfOverLimit(userId: string): Promise<void> {
    const sessions = await prismaRead.session.findMany({
      where: { userId, isActive: true, isRevoked: false },
      orderBy: { lastActiveAt: 'asc' },
      select: { id: true },
    })
    if (sessions.length <= MAX_SESSIONS_PER_USER) return
    const toRevokeIds = sessions
      .slice(0, sessions.length - MAX_SESSIONS_PER_USER)
      .map((s) => s.id)
    await prisma.session.updateMany({
      where: { id: { in: toRevokeIds } },
      data: { isActive: false, isRevoked: true, revokedAt: new Date() },
    })
  },
}
