import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { sessionRepository } from '../repositories/session.repository'
import { deviceRegistryRepository } from '../repositories/device-registry.repository'
import { userRepository } from '../repositories/user.repository'
import { redisClient, RedisKeys } from '../config/redis'
import { signAccess, signRefresh, verifyRefresh, parseJwtExpiresToSeconds } from '../utils/jwt'
import { AppError } from '../middlewares/errorHandler'
import { env } from '../config/env'
import { displayNameFromUser } from '../utils/profileDisplay'
import { computeDeviceBindingHash, hashIp, hashUserAgent } from '../utils/deviceFingerprint'
import { authSessionMetrics } from './auth-observability'
import { auditService } from './audit.service'

const REFRESH_DAYS = 7
const REFRESH_SEC = REFRESH_DAYS * 24 * 60 * 60
const USER_TV_CACHE_SEC = 3600
const LOGIN_TX_MAX_ATTEMPTS = 3

function isPrismaUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

export type SessionRedisBlob = {
  userId: string
  deviceId: string
  refreshTokenHash: string
  ipAddress: string
  userTokenVersion: number
  sessionTokenVersion: number
  revoked: boolean
}

function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function accessTtlSeconds(): number {
  return parseJwtExpiresToSeconds(env.JWT_ACCESS_EXPIRES_IN)
}

async function writeSessionRedis(sessionId: string, blob: SessionRedisBlob): Promise<void> {
  await redisClient.set(RedisKeys.session(sessionId), JSON.stringify(blob), 'EX', REFRESH_SEC)
}

async function cacheUserTokenVersion(userId: string, version: number): Promise<void> {
  await redisClient.set(
    RedisKeys.userTokenVersion(userId),
    String(version),
    'EX',
    USER_TV_CACHE_SEC,
  )
}

export async function invalidateUserTokenVersionCache(userId: string): Promise<void> {
  await redisClient.del(RedisKeys.userTokenVersion(userId))
}

export async function resolveUserTokenVersion(userId: string): Promise<number> {
  try {
    const t0 = Date.now()
    const cached = await redisClient.get(RedisKeys.userTokenVersion(userId))
    authSessionMetrics.recordAuthRedisMs(Date.now() - t0)
    if (cached != null) return Number(cached)
  } catch {
    // Redis unavailable: fall through to DB
  }
  const t1 = Date.now()
  const v = await userRepository.getTokenVersion(userId)
  authSessionMetrics.recordAuthDbMs(Date.now() - t1)
  const tv = v ?? 0
  try {
    await cacheUserTokenVersion(userId, tv)
  } catch {
    // ignore cache write failure
  }
  return tv
}

async function hydrateSessionBlob(sessionId: string): Promise<SessionRedisBlob | null> {
  const t0 = Date.now()
  const s = await sessionRepository.findById(sessionId)
  authSessionMetrics.recordAuthDbMs(Date.now() - t0)
  if (!s || s.isRevoked || !s.isActive) return null
  const utv = await resolveUserTokenVersion(s.userId)
  return {
    userId: s.userId,
    deviceId: s.deviceId,
    refreshTokenHash: s.refreshTokenHash,
    ipAddress: s.ipAddress,
    userTokenVersion: utv,
    sessionTokenVersion: s.tokenVersion,
    revoked: false,
  }
}

async function acquireRefreshLock(sessionId: string): Promise<() => Promise<void>> {
  const key = RedisKeys.refreshLock(sessionId)
  const ok = await redisClient.set(key, '1', 'EX', 5, 'NX')
  if (ok === 'OK') {
    return async () => {
      await redisClient.del(key)
    }
  }
  await new Promise((r) => setTimeout(r, 120))
  const ok2 = await redisClient.set(key, '1', 'EX', 5, 'NX')
  if (ok2 !== 'OK') {
    authSessionMetrics.refreshConflict += 1
    throw new AppError(429, 'Refresh already in progress', 'REFRESH_CONFLICT')
  }
  return async () => {
    await redisClient.del(key)
  }
}

/**
 * Session lifecycle: create, rotate refresh in-place, revoke, list.
 */
export const sessionService = {
  async createSession(params: {
    userId: string
    publicId: number
    passwordSet: boolean
    deviceName: string
    deviceId: string
    ipAddress: string
    userAgent?: string | null
    loginType?: string
    displayName: string
    avatarUrl: string | null
    isSupport?: boolean
  }) {
    const started = Date.now()
    const fpHash = computeDeviceBindingHash(params.deviceId, params.userAgent, params.ipAddress)

    const prior = await deviceRegistryRepository.findByUserAndDevice(params.userId, params.deviceId)
    if (prior?.deviceFingerprintHash != null && prior.deviceFingerprintHash !== fpHash) {
      await auditService.log({
        userId: params.userId,
        actionType: 'SUSPICIOUS_DEVICE_BINDING',
        actionStatus: 'success',
        actionDetails: {
          deviceId: params.deviceId,
          previousHashPrefix: prior.deviceFingerprintHash.slice(0, 8),
        },
        deviceId: params.deviceId,
      })
    }

    const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000)

    let loginOutcome:
      | Awaited<ReturnType<typeof sessionRepository.loginCreateOrReuseSession>>
      | undefined

    for (let attempt = 0; attempt < LOGIN_TX_MAX_ATTEMPTS; attempt++) {
      const newSessionId = crypto.randomUUID()
      try {
        loginOutcome = await sessionRepository.loginCreateOrReuseSession({
          newSessionId,
          userId: params.userId,
          deviceName: params.deviceName,
          deviceId: params.deviceId,
          deviceFingerprint: fpHash,
          deviceFingerprintHash: fpHash,
          ipHash: hashIp(params.ipAddress),
          userAgentHash: hashUserAgent(params.userAgent),
          ipAddress: params.ipAddress,
          userAgent: params.userAgent ?? undefined,
          expiresAt,
          loginType: params.loginType ?? undefined,
          buildRefresh: (sessionId) => {
            const rt = signRefresh({
              userId: params.userId,
              sessionId,
              jti: sessionId,
            })
            return { refreshToken: rt, refreshTokenHash: hashRefreshToken(rt) }
          },
        })
        break
      } catch (e) {
        if (attempt < LOGIN_TX_MAX_ATTEMPTS - 1 && isPrismaUniqueViolation(e)) {
          continue
        }
        throw e
      }
    }

    if (loginOutcome == null) {
      throw new AppError(503, 'Could not establish session', 'SESSION_LOGIN_FAILED')
    }

    const { session, refreshToken, revokedSessionIds, reused } = loginOutcome

    for (const rid of revokedSessionIds) {
      await redisClient.del(RedisKeys.session(rid))
      authSessionMetrics.bumpRevoke()
    }

    await deviceRegistryRepository.upsert({
      userId: params.userId,
      deviceId: params.deviceId,
      deviceName: params.deviceName,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent ?? undefined,
      deviceFingerprintHash: fpHash,
      ipHash: hashIp(params.ipAddress),
      userAgentHash: hashUserAgent(params.userAgent),
    })

    const userTv = await resolveUserTokenVersion(params.userId)
    const accessToken = signAccess(
      {
        sub: params.userId,
        userId: params.userId,
        publicId: params.publicId,
        passwordSet: params.passwordSet,
        name: params.displayName,
        avatarUrl: params.avatarUrl,
        deviceId: params.deviceId,
        sessionId: session.id,
        tokenVersion: userTv,
        sessionTokenVersion: session.tokenVersion,
        jti: crypto.randomUUID(),
        isSupport: params.isSupport ?? false,
      },
      env.JWT_ACCESS_EXPIRES_IN,
    )

    await writeSessionRedis(session.id, {
      userId: params.userId,
      deviceId: params.deviceId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      ipAddress: params.ipAddress,
      userTokenVersion: userTv,
      sessionTokenVersion: session.tokenVersion,
      revoked: false,
    })

    if (!reused) {
      authSessionMetrics.bumpSessionCreate()
    }
    authSessionMetrics.recordLoginMs(Date.now() - started)

    return {
      accessToken,
      refreshToken,
      sessionId: session.id,
      expiresIn: accessTtlSeconds(),
    }
  },

  /**
   * Rotate refresh token in-place (same session row). Serialised with Redis lock per sessionId.
   */
  async rotateRefresh(refreshToken: string, ipAddress: string) {
    const started = Date.now()
    let payload: { userId: string; sessionId: string; jti: string }
    try {
      payload = verifyRefresh(refreshToken)
    } catch {
      authSessionMetrics.refreshFail += 1
      throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN')
    }

    const release = await acquireRefreshLock(payload.sessionId)
    try {
      const session = await sessionRepository.findByRefreshTokenHash(hashRefreshToken(refreshToken))
      if (!session || session.userId !== payload.userId) {
        authSessionMetrics.refreshFail += 1
        throw new AppError(401, 'Session revoked or invalid', 'SESSION_INVALID')
      }

      const newRefreshToken = signRefresh({
        userId: payload.userId,
        sessionId: session.id,
        jti: session.id,
      })
      const newHash = hashRefreshToken(newRefreshToken)

      const { sessionTokenVersion } = await sessionRepository.updateRefreshTokenAndBumpVersion(
        session.id,
        newHash,
      )

      const user = session.user
      const publicId = Number(user.publicId)
      const passwordSet = user.passwordSet
      const userTv = await resolveUserTokenVersion(payload.userId)

      const accessToken = signAccess(
        {
          sub: user.id,
          userId: user.id,
          publicId,
          passwordSet,
          name: displayNameFromUser(user),
          avatarUrl: user.avatarUrl,
          deviceId: session.deviceId,
          sessionId: session.id,
          tokenVersion: userTv,
          sessionTokenVersion,
          jti: crypto.randomUUID(),
          isSupport: user.isSupport ?? false,
        },
        env.JWT_ACCESS_EXPIRES_IN,
      )

      await writeSessionRedis(session.id, {
        userId: session.userId,
        deviceId: session.deviceId,
        refreshTokenHash: newHash,
        ipAddress,
        userTokenVersion: userTv,
        sessionTokenVersion,
        revoked: false,
      })

      authSessionMetrics.refreshSuccess += 1
      authSessionMetrics.recordRefreshMs(Date.now() - started)

      return {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: accessTtlSeconds(),
        sessionId: session.id,
      }
    } finally {
      await release()
    }
  },

  async validateAccessSession(
    sessionId: string,
    expectedSessionTokenVersion: number,
    userId: string,
  ): Promise<void> {
    const raw = await redisClient.get(RedisKeys.session(sessionId))
    if (raw) {
      let blob: SessionRedisBlob
      try {
        blob = JSON.parse(raw) as SessionRedisBlob
      } catch {
        blob = { revoked: true } as SessionRedisBlob
      }
      try {
        if (blob.revoked || blob.userId !== userId) {
          throw new AppError(401, 'Session invalid', 'SESSION_INVALID')
        }
        if (blob.sessionTokenVersion !== expectedSessionTokenVersion) {
          throw new AppError(401, 'Session token stale', 'SESSION_TOKEN_STALE')
        }
        return
      } catch (e) {
        if (e instanceof AppError) throw e
      }
    }
    const hydrated = await hydrateSessionBlob(sessionId)
    if (!hydrated || hydrated.userId !== userId) {
      throw new AppError(401, 'Session invalid', 'SESSION_INVALID')
    }
    if (hydrated.sessionTokenVersion !== expectedSessionTokenVersion) {
      throw new AppError(401, 'Session token stale', 'SESSION_TOKEN_STALE')
    }
    await writeSessionRedis(sessionId, hydrated)
  },

  /**
   * Invalidate outstanding access JWTs for this session without revoking refresh.
   * Bumps sessions.token_version (access checks return SESSION_TOKEN_STALE); refresh hash unchanged.
   */
  async invalidateAccessToken(
    sessionId: string,
    userId: string,
  ): Promise<{ sessionTokenVersion: number }> {
    const session = await sessionRepository.findById(sessionId)
    if (!session) throw new AppError(404, 'Session not found', 'SESSION_NOT_FOUND')
    if (session.userId !== userId) {
      throw new AppError(403, 'Cannot invalidate another user session', 'FORBIDDEN')
    }
    if (session.isRevoked || !session.isActive) {
      throw new AppError(401, 'Session invalid', 'SESSION_INVALID')
    }

    const { sessionTokenVersion } = await sessionRepository.bumpTokenVersionOnly(sessionId)

    const raw = await redisClient.get(RedisKeys.session(sessionId))
    if (raw) {
      try {
        const blob = JSON.parse(raw) as SessionRedisBlob
        if (!blob.revoked && blob.userId === userId) {
          await writeSessionRedis(sessionId, { ...blob, sessionTokenVersion })
        }
      } catch {
        const hydrated = await hydrateSessionBlob(sessionId)
        if (hydrated) {
          await writeSessionRedis(sessionId, { ...hydrated, sessionTokenVersion })
        }
      }
    } else {
      const hydrated = await hydrateSessionBlob(sessionId)
      if (hydrated) {
        await writeSessionRedis(sessionId, { ...hydrated, sessionTokenVersion })
      }
    }

    return { sessionTokenVersion }
  },

  async revokeSession(sessionId: string, userId: string) {
    const session = await sessionRepository.findById(sessionId)
    if (!session) throw new AppError(404, 'Session not found', 'SESSION_NOT_FOUND')
    if (session.userId !== userId)
      throw new AppError(403, 'Cannot revoke another user session', 'FORBIDDEN')
    await sessionRepository.revokeById(sessionId)
    await redisClient.del(RedisKeys.session(sessionId))
    if (session.deviceId) {
      await redisClient.del(RedisKeys.deviceLinkedAccounts(session.deviceId))
    }
    authSessionMetrics.bumpRevoke()
  },

  /**
   * Revoke every session and bump user.tokenVersion (invalidates all access JWTs).
   * Redis deletes are batched in a single pipeline to avoid partial revocation if the
   * process crashes between individual DEL calls.
   */
  async revokeAllSessions(userId: string) {
    const sessions = await sessionRepository.findActiveByUserId(userId)
    await sessionRepository.revokeAllByUserId(userId)
    if (sessions.length > 0) {
      const deviceIds = new Set(sessions.map((s) => s.deviceId).filter(Boolean))
      const pipe = redisClient.pipeline()
      for (const s of sessions) {
        pipe.del(RedisKeys.session(s.id))
      }
      for (const deviceId of deviceIds) {
        pipe.del(RedisKeys.deviceLinkedAccounts(deviceId))
      }
      await pipe.exec()
    }
    await userRepository.incrementTokenVersion(userId)
    await invalidateUserTokenVersionCache(userId)
    authSessionMetrics.bumpRevoke()
  },

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
