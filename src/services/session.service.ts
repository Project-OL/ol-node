import crypto from 'crypto'
import { sessionRepository } from '../repositories/session.repository'
import { deviceRegistryRepository } from '../repositories/device-registry.repository'
import { redisClient, RedisKeys } from '../config/redis'
import { signAccess, signRefresh, verifyRefresh } from '../utils/jwt'
import { AppError } from '../middlewares/errorHandler'

const REFRESH_DAYS = 7
const ACCESS_EXPIRY = '15m'

function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Session lifecycle: create, rotate refresh token, revoke (single or all), list.
 * Sessions are stored in DB and optionally in Redis for revocation checks.
 */
export const sessionService = {
  /**
   * Create a new session for a user; returns access + refresh tokens and sessionId.
   * Enforces per-user session limit by revoking oldest sessions.
   */
  async createSession(params: {
    userId: string
    publicId: number
    passwordSet: boolean
    deviceName: string
    deviceId: string
    ipAddress: string
    userAgent?: string | null
    loginType?: string
  }) {
    await sessionRepository.deleteOldestSessionsIfOverLimit(params.userId)
    const sessionId = crypto.randomUUID()
    const refreshToken = signRefresh({
      userId: params.userId,
      sessionId,
      jti: sessionId,
    })
    const refreshTokenHash = hashRefreshToken(refreshToken)
    const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000)
    const session =     await sessionRepository.create({
      id: sessionId,
      refreshTokenHash,
      userId: params.userId,
      deviceName: params.deviceName,
      deviceId: params.deviceId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent ?? undefined,
      expiresAt,
      loginType: params.loginType ?? undefined,
    })
    await deviceRegistryRepository.upsert({
      userId: params.userId,
      deviceId: params.deviceId,
      deviceName: params.deviceName,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent ?? undefined,
    })
    const accessJti = crypto.randomUUID()
    const accessToken = signAccess(
      {
        userId: params.userId,
        publicId: params.publicId,
        passwordSet: params.passwordSet,
        jti: accessJti,
        deviceId: params.deviceId,
      },
      ACCESS_EXPIRY,
    )
    await redisClient.set(
      RedisKeys.session(session.id),
      JSON.stringify({
        userId: params.userId,
        deviceId: params.deviceId,
        refreshTokenHash,
        ipAddress: params.ipAddress,
      }),
      'EX',
      REFRESH_DAYS * 24 * 60 * 60,
    )
    return {
      accessToken,
      refreshToken,
      sessionId: session.id,
      expiresIn: 900,
    }
  },

  /**
   * Validate refresh token, revoke current session, create a new session and return new tokens.
   * @throws AppError INVALID_REFRESH_TOKEN | SESSION_INVALID
   */
  async rotateRefresh(refreshToken: string, ipAddress: string) {
    let payload: { userId: string; sessionId: string; jti: string }
    try {
      payload = verifyRefresh(refreshToken)
    } catch {
      throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN')
    }
    const session = await sessionRepository.findByRefreshTokenHash(hashRefreshToken(refreshToken))
    if (!session || session.userId !== payload.userId) {
      throw new AppError(401, 'Session revoked or invalid', 'SESSION_INVALID')
    }
    await sessionRepository.revokeById(session.id)
    await redisClient.del(RedisKeys.session(session.id))
    const user = session.user
    const publicId = Number(user.publicId)
    const passwordSet = user.passwordSet
    return this.createSession({
      userId: user.id,
      publicId,
      passwordSet,
      deviceName: session.deviceName,
      deviceId: session.deviceId,
      ipAddress,
      loginType: session.loginType ?? undefined,
    })
  },

  /** Revoke a single session by id; enforces that session belongs to userId. */
  async revokeSession(sessionId: string, userId: string) {
    const session = await sessionRepository.findById(sessionId)
    if (!session) throw new AppError(404, 'Session not found', 'SESSION_NOT_FOUND')
    if (session.userId !== userId) throw new AppError(403, 'Cannot revoke another user session', 'FORBIDDEN')
    await sessionRepository.revokeById(sessionId)
    await redisClient.del(RedisKeys.session(sessionId))
  },

  /** Revoke all active sessions for a user (DB + Redis). */
  async revokeAllSessions(userId: string) {
    const sessions = await sessionRepository.findActiveByUserId(userId)
    await sessionRepository.revokeAllByUserId(userId)
    for (const s of sessions) {
      await redisClient.del(RedisKeys.session(s.id))
    }
  },

  /** List active sessions for the user; optionally mark current session. */
  async listSessions(userId: string, currentSessionId?: string) {
    const sessions = await sessionRepository.findActiveByUserId(userId)
    return sessions.map((s) => ({
      sessionId: s.id,
      deviceName: s.deviceName,
      deviceId: s.deviceId,
      isCurrentDevice: currentSessionId ? s.id === currentSessionId : false,
      lastActiveAt: s.lastActiveAt.toISOString(),
      ipAddress: s.ipAddress,
      loginType: s.loginType ?? undefined,
    }))
  },
}
