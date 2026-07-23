import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import {
  redisClient,
  RedisKeys,
  ADMIN_LOGIN_FAIL_TTL,
  ADMIN_LOGIN_FAIL_LIMIT,
  ADMIN_LOCKOUT_THRESHOLD,
  ADMIN_LOCKOUT_MINUTES,
} from '../config/redis'
import { systemAdminRepository, type AdminProfileData } from '../repositories/systemAdmin.repository'
import { AppError } from '../middlewares/errorHandler'
import { parseJwtExpiresToSeconds } from '../utils/jwt'
import type { AdminRole } from '@prisma/client'

const BCRYPT_ROUNDS = 12

interface AdminAccessPayload {
  sub: string
  role: AdminRole
  iss: 'offoo-admin'
  type: 'access'
}

interface AdminRefreshPayload {
  sub: string
  sessionId: string
  iss: 'offoo-admin'
  type: 'refresh'
}

function refreshExpiresAt(): Date {
  return new Date(Date.now() + parseJwtExpiresToSeconds(env.ADMIN_JWT_REFRESH_EXPIRES_IN) * 1000)
}

function accessTokenTtlSeconds(): number {
  return parseJwtExpiresToSeconds(env.ADMIN_JWT_ACCESS_EXPIRES_IN)
}

function signAccessToken(adminId: string, role: AdminRole): string {
  return jwt.sign(
    { sub: adminId, role, iss: 'offoo-admin', type: 'access' } satisfies AdminAccessPayload,
    env.ADMIN_JWT_SECRET,
    { expiresIn: env.ADMIN_JWT_ACCESS_EXPIRES_IN, algorithm: 'HS256' } as jwt.SignOptions,
  )
}

function signRefreshToken(adminId: string, sessionId: string): string {
  return jwt.sign(
    { sub: adminId, sessionId, iss: 'offoo-admin', type: 'refresh' } satisfies AdminRefreshPayload,
    env.ADMIN_JWT_REFRESH_SECRET,
    { expiresIn: env.ADMIN_JWT_REFRESH_EXPIRES_IN, algorithm: 'HS256' } as jwt.SignOptions,
  )
}

export const systemAdminService = {
  async createAdmin(
    data: {
      email: string
      password: string
      displayName: string
      role?: AdminRole
    } & AdminProfileData,
  ) {
    const existing = await systemAdminRepository.findByEmail(data.email)
    if (existing) throw new AppError(409, 'Email already registered', 'ADMIN_EMAIL_CONFLICT')
    if (data.username) {
      const usernameTaken = await systemAdminRepository.findByUsername(data.username)
      if (usernameTaken) throw new AppError(409, 'Username already taken', 'ADMIN_USERNAME_CONFLICT')
    }

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS)
    return systemAdminRepository.create({
      email: data.email,
      passwordHash,
      displayName: data.displayName,
      role: data.role ?? 'MODERATOR',
      username: data.username ?? null,
      phone: data.phone ?? null,
      phoneCountryCode: data.phoneCountryCode ?? null,
      gender: data.gender ?? null,
      country: data.country ?? null,
    })
  },

  async login(email: string, password: string, meta: { ipAddress?: string; userAgent?: string }) {
    // Pre-DB throttle: brakes dictionary attacks even for unknown emails.
    const failKey = RedisKeys.adminLoginFail(email)
    const recentFailures = Number((await redisClient.get(failKey).catch(() => null)) ?? 0)
    if (recentFailures >= ADMIN_LOGIN_FAIL_LIMIT) {
      throw new AppError(429, 'Too many login attempts. Try again later.', 'TOO_MANY_ATTEMPTS', {
        retryAfter: ADMIN_LOGIN_FAIL_TTL,
      })
    }

    const admin = await systemAdminRepository.findByEmail(email)
    if (!admin || !admin.isActive) {
      await recordLoginFailure(failKey)
      throw new AppError(401, 'Invalid credentials', 'ADMIN_INVALID_CREDENTIALS')
    }

    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      const retryAfter = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 1000)
      throw new AppError(423, 'Account temporarily locked', 'ADMIN_ACCOUNT_LOCKED', { retryAfter })
    }

    const valid = await bcrypt.compare(password, admin.passwordHash)
    if (!valid) {
      await recordLoginFailure(failKey)
      const updated = await systemAdminRepository.incrementFailedLogin(admin.id)
      if (updated.failedLoginCount >= ADMIN_LOCKOUT_THRESHOLD) {
        const until = new Date(Date.now() + ADMIN_LOCKOUT_MINUTES * 60_000)
        await systemAdminRepository.setLockedUntil(admin.id, until)
        console.warn('[admin-auth] account locked after repeated failures', {
          adminId: admin.id,
          lockedUntil: until.toISOString(),
        })
      }
      throw new AppError(401, 'Invalid credentials', 'ADMIN_INVALID_CREDENTIALS')
    }

    if (admin.failedLoginCount > 0 || admin.lockedUntil) {
      await systemAdminRepository.resetFailedLogin(admin.id)
    }

    // A successful login supersedes any earlier logout/disable revocation —
    // without this, the admin:revoked flag (TTL = access-token TTL) would
    // reject the freshly minted token too.
    await redisClient.del(RedisKeys.adminTokenRevoked(admin.id)).catch(() => null)

    const placeholderHash = await bcrypt.hash(cryptoRandom(), 10)
    const session = await systemAdminRepository.createSession({
      adminId: admin.id,
      tokenHash: placeholderHash,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      expiresAt: refreshExpiresAt(),
    })

    const refreshToken = signRefreshToken(admin.id, session.id)
    const tokenHash = await bcrypt.hash(refreshToken, 10)
    await systemAdminRepository.updateSessionTokenHash(session.id, tokenHash)
    await systemAdminRepository.updateLastLogin(admin.id)

    return {
      accessToken: signAccessToken(admin.id, admin.role),
      refreshToken,
      admin: {
        id: admin.id,
        email: admin.email,
        displayName: admin.displayName,
        role: admin.role,
        username: admin.username,
        country: admin.country,
        status: admin.status,
      },
    }
  },

  async refresh(refreshToken: string) {
    let payload: AdminRefreshPayload
    try {
      payload = jwt.verify(refreshToken, env.ADMIN_JWT_REFRESH_SECRET) as AdminRefreshPayload
    } catch {
      throw new AppError(401, 'Invalid or expired refresh token', 'ADMIN_TOKEN_INVALID')
    }

    if (payload.iss !== 'offoo-admin' || payload.type !== 'refresh') {
      throw new AppError(401, 'Invalid token type', 'ADMIN_TOKEN_INVALID')
    }

    const session = await systemAdminRepository.findSessionById(payload.sessionId)
    if (!session || session.adminId !== payload.sub) {
      throw new AppError(401, 'Session not found or expired', 'ADMIN_TOKEN_INVALID')
    }

    const hashValid = await bcrypt.compare(refreshToken, session.tokenHash)
    if (!hashValid) {
      throw new AppError(401, 'Invalid refresh token', 'ADMIN_TOKEN_INVALID')
    }

    if (!session.admin.isActive) {
      throw new AppError(401, 'Admin not found or inactive', 'ADMIN_INVALID_CREDENTIALS')
    }

    return {
      accessToken: signAccessToken(session.admin.id, session.admin.role),
    }
  },

  async logout(adminId: string) {
    await systemAdminRepository.revokeAllSessions(adminId).catch(() => null)
    await redisClient.set(RedisKeys.adminTokenRevoked(adminId), '1', 'EX', accessTokenTtlSeconds())
  },

  async verifyAccessToken(token: string): Promise<AdminAccessPayload> {
    try {
      const payload = jwt.verify(token, env.ADMIN_JWT_SECRET) as AdminAccessPayload
      if (payload.iss !== 'offoo-admin' || payload.type !== 'access') {
        throw new Error('wrong token type')
      }

      const revoked = await redisClient.get(RedisKeys.adminTokenRevoked(payload.sub))
      if (revoked) {
        throw new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID')
      }

      const admin = await systemAdminRepository.findById(payload.sub)
      if (!admin?.isActive) {
        throw new AppError(401, 'Admin not found or inactive', 'ADMIN_INVALID_CREDENTIALS')
      }

      return payload
    } catch (e) {
      if (e instanceof AppError) throw e
      throw new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID')
    }
  },
}

function cryptoRandom(): string {
  return `${Date.now()}-${Math.random()}`
}

async function recordLoginFailure(failKey: string): Promise<void> {
  try {
    const count = await redisClient.incr(failKey)
    if (count === 1) await redisClient.expire(failKey, ADMIN_LOGIN_FAIL_TTL)
  } catch {
    // Redis unavailable — fail open; the DB lockout still protects known accounts.
  }
}
