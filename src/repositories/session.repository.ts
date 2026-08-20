import { Prisma, type Session } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export const MAX_SESSIONS_PER_USER = 3

export type LoginCreateOrReuseResult = {
  session: Session
  refreshToken: string
  revokedSessionIds: string[]
  reused: boolean
}

export const sessionRepository = {
  async create(data: {
    id?: string
    userId: string
    deviceName: string
    deviceId: string
    deviceFingerprint?: string | null
    deviceFingerprintHash?: string | null
    ipHash?: string | null
    userAgentHash?: string | null
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
        deviceFingerprintHash: data.deviceFingerprintHash ?? undefined,
        ipHash: data.ipHash ?? undefined,
        userAgentHash: data.userAgentHash ?? undefined,
        refreshTokenHash: data.refreshTokenHash,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent ?? undefined,
        expiresAt: data.expiresAt,
        loginType: data.loginType ?? undefined,
      },
    })
  },

  /**
   * Login: lock existing non-revoked row for (user, device) and reuse (rotate refresh + bump tokenVersion),
   * else cap active sessions and INSERT. Caller supplies buildRefresh so JWT sessionId matches the row.
   */
  async loginCreateOrReuseSession(data: {
    newSessionId: string
    userId: string
    deviceName: string
    deviceId: string
    deviceFingerprint?: string | null
    deviceFingerprintHash?: string | null
    ipHash?: string | null
    userAgentHash?: string | null
    ipAddress: string
    userAgent?: string | null
    expiresAt: Date
    loginType?: string | null
    buildRefresh: (sessionId: string) => { refreshToken: string; refreshTokenHash: string }
  }): Promise<LoginCreateOrReuseResult> {
    return prisma.$transaction(async (tx) => {
      const lockedPair = await tx.$queryRaw<Array<{ id: string; updated_at: Date }>>(Prisma.sql`
        SELECT id, updated_at FROM sessions
        WHERE user_id = ${data.userId}::uuid
          AND device_id = ${data.deviceId}
          AND is_revoked = false
        ORDER BY updated_at DESC
        FOR UPDATE
      `)

      const revokedSessionIds: string[] = []

      if (lockedPair.length > 0) {
        const sorted = [...lockedPair].sort(
          (a, b) => b.updated_at.getTime() - a.updated_at.getTime(),
        )
        const keepId = sorted[0]!.id
        const killIds = sorted.slice(1).map((r) => r.id)
        if (killIds.length > 0) {
          revokedSessionIds.push(...killIds)
          await tx.session.updateMany({
            where: { id: { in: killIds } },
            data: { isActive: false, isRevoked: true, revokedAt: new Date() },
          })
        }

        const { refreshToken, refreshTokenHash } = data.buildRefresh(keepId)
        const session = await tx.session.update({
          where: { id: keepId },
          data: {
            refreshTokenHash,
            tokenVersion: { increment: 1 },
            deviceName: data.deviceName,
            deviceFingerprint: data.deviceFingerprint ?? undefined,
            deviceFingerprintHash: data.deviceFingerprintHash ?? undefined,
            ipHash: data.ipHash ?? undefined,
            userAgentHash: data.userAgentHash ?? undefined,
            ipAddress: data.ipAddress,
            userAgent: data.userAgent ?? undefined,
            expiresAt: data.expiresAt,
            isActive: true,
            isRevoked: false,
            revokedAt: null,
            lastActiveAt: new Date(),
            loginType: data.loginType ?? undefined,
          },
        })
        return { session, refreshToken, revokedSessionIds, reused: true }
      }

      const lockedRows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM sessions
        WHERE user_id = ${data.userId}::uuid
          AND is_active = true
          AND is_revoked = false
          AND expires_at > NOW()
        ORDER BY created_at ASC
        FOR UPDATE
      `)
      if (lockedRows.length >= MAX_SESSIONS_PER_USER) {
        const excess = lockedRows.length - MAX_SESSIONS_PER_USER + 1
        const toRevoke = lockedRows.slice(0, excess).map((r) => r.id)
        revokedSessionIds.push(...toRevoke)
        await tx.session.updateMany({
          where: { id: { in: toRevoke } },
          data: { isActive: false, isRevoked: true, revokedAt: new Date() },
        })
      }

      const { refreshToken, refreshTokenHash } = data.buildRefresh(data.newSessionId)
      const session = await tx.session.create({
        data: {
          id: data.newSessionId,
          userId: data.userId,
          deviceName: data.deviceName,
          deviceId: data.deviceId,
          deviceFingerprint: data.deviceFingerprint ?? undefined,
          deviceFingerprintHash: data.deviceFingerprintHash ?? undefined,
          ipHash: data.ipHash ?? undefined,
          userAgentHash: data.userAgentHash ?? undefined,
          refreshTokenHash,
          ipAddress: data.ipAddress,
          userAgent: data.userAgent ?? undefined,
          expiresAt: data.expiresAt,
          loginType: data.loginType ?? undefined,
        },
      })
      return { session, refreshToken, revokedSessionIds, reused: false }
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

  async findActiveByDeviceId(deviceId: string) {
    return prismaRead.session.findMany({
      where: {
        deviceId,
        isActive: true,
        isRevoked: false,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        userId: true,
        deviceId: true,
        deviceName: true,
        lastActiveAt: true,
      },
    })
  },

  /** Active sessions on any of the given physical device ids, excluding one user (admin co-login lookup). */
  async findActiveOnDeviceIdsExcludingUser(deviceIds: string[], excludeUserId: string) {
    if (deviceIds.length === 0) return []
    return prismaRead.session.findMany({
      where: {
        deviceId: { in: deviceIds },
        userId: { not: excludeUserId },
        isActive: true,
        isRevoked: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        userId: true,
        deviceId: true,
        deviceName: true,
        ipAddress: true,
        lastActiveAt: true,
        loginType: true,
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            avatarUrl: true,
            status: true,
          },
        },
      },
    })
  },

  async revokeAllByDeviceId(deviceId: string): Promise<string[]> {
    const sessions = await prismaRead.session.findMany({
      where: {
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

  async updateLastActive(id: string) {
    return prisma.session.update({
      where: { id },
      data: { lastActiveAt: new Date() },
    })
  },

  /** Bump session tokenVersion only (invalidates outstanding access JWTs; refresh hash unchanged). */
  async bumpTokenVersionOnly(sessionId: string): Promise<{ sessionTokenVersion: number }> {
    const row = await prisma.session.update({
      where: { id: sessionId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    })
    return { sessionTokenVersion: row.tokenVersion }
  },

  /** In-place refresh rotation: new hash + bump session tokenVersion (invalidates old access JWTs for this session). */
  async updateRefreshTokenAndBumpVersion(
    sessionId: string,
    newRefreshTokenHash: string,
  ): Promise<{ sessionTokenVersion: number }> {
    const row = await prisma.session.update({
      where: { id: sessionId },
      data: {
        refreshTokenHash: newRefreshTokenHash,
        tokenVersion: { increment: 1 },
      },
      select: { tokenVersion: true },
    })
    return { sessionTokenVersion: row.tokenVersion }
  },

  async deleteOldestSessionsIfOverLimit(userId: string): Promise<void> {
    const sessions = await prismaRead.session.findMany({
      where: { userId, isActive: true, isRevoked: false },
      orderBy: { lastActiveAt: 'asc' },
      select: { id: true },
    })
    if (sessions.length <= MAX_SESSIONS_PER_USER) return
    const toRevokeIds = sessions.slice(0, sessions.length - MAX_SESSIONS_PER_USER).map((s) => s.id)
    await prisma.session.updateMany({
      where: { id: { in: toRevokeIds } },
      data: { isActive: false, isRevoked: true, revokedAt: new Date() },
    })
  },
}
