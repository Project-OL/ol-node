import { randomBytes } from 'crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import {
  redisClient,
  RedisKeys,
  ADMIN_LOGIN_FAIL_TTL,
  ADMIN_LOGIN_FAIL_LIMIT,
} from '../config/redis'
import { systemAdminRepository, type AdminProfileData } from '../repositories/systemAdmin.repository'
import { AppError } from '../middlewares/errorHandler'
import { parseJwtExpiresToSeconds } from '../utils/jwt'
import { normalizeIp } from '../utils/ipAddress'
import { passwordService } from './password.service'
import { adminAuthConfigService } from './adminAuthConfig.service'
import { auditService } from './audit.service'
import { adminLoginFailureRepository } from '../repositories/adminLoginFailure.repository'
import type { AdminLoginFailureReason, AdminRole } from '@prisma/client'

const BCRYPT_ROUNDS = 12

interface AdminAccessPayload {
  sub: string
  role: AdminRole
  iss: 'offoo-admin'
  type: 'access'
  /** Bound for single-session roles so a new login can invalidate prior access JWTs. */
  sessionId?: string
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

function signAccessToken(adminId: string, role: AdminRole, sessionId?: string): string {
  const payload: AdminAccessPayload = {
    sub: adminId,
    role,
    iss: 'offoo-admin',
    type: 'access',
    ...(sessionId ? { sessionId } : {}),
  }
  return jwt.sign(payload, env.ADMIN_JWT_SECRET, {
    expiresIn: env.ADMIN_JWT_ACCESS_EXPIRES_IN,
    algorithm: 'HS256',
  } as jwt.SignOptions)
}

function signRefreshToken(adminId: string, sessionId: string): string {
  return jwt.sign(
    { sub: adminId, sessionId, iss: 'offoo-admin', type: 'refresh' } satisfies AdminRefreshPayload,
    env.ADMIN_JWT_REFRESH_SECRET,
    { expiresIn: env.ADMIN_JWT_REFRESH_EXPIRES_IN, algorithm: 'HS256' } as jwt.SignOptions,
  )
}

async function persistFailedLogin(
  admin: { id: string; email: string },
  reason: AdminLoginFailureReason,
  meta: { ipAddress?: string; userAgent?: string },
) {
  auditService.logAdmin({
    adminUserId: admin.id,
    actionType: 'ADMIN_LOGIN',
    actionStatus: 'failed',
    actionDetails: { reason, email: admin.email },
    destination: 'Admin login',
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  })
  try {
    await adminLoginFailureRepository.create({
      adminId: admin.id,
      email: admin.email,
      reason,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
  } catch (err) {
    console.error('[admin-auth] failed-login log write failed', err)
  }
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
      if (admin) {
        await persistFailedLogin(admin, 'INVALID_CREDENTIALS', meta)
        await systemAdminRepository.touchLastFailedLogin(admin.id).catch(() => null)
      }
      throw new AppError(401, 'Invalid credentials', 'ADMIN_INVALID_CREDENTIALS')
    }

    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      await persistFailedLogin(admin, 'ACCOUNT_LOCKED', meta)
      await systemAdminRepository.touchLastFailedLogin(admin.id).catch(() => null)
      const retryAfter = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 1000)
      throw new AppError(423, 'Account temporarily locked', 'ADMIN_ACCOUNT_LOCKED', { retryAfter })
    }

    const valid = await bcrypt.compare(password, admin.passwordHash)
    if (!valid) {
      await recordLoginFailure(failKey)
      await persistFailedLogin(admin, 'INVALID_CREDENTIALS', meta)
      const updated = await systemAdminRepository.incrementFailedLogin(admin.id)
      const { failedLoginThreshold, lockoutMinutes } =
        await adminAuthConfigService.getLockoutSettings()
      if (updated.failedLoginCount >= failedLoginThreshold) {
        const until = new Date(Date.now() + lockoutMinutes * 60_000)
        await systemAdminRepository.setLockedUntil(admin.id, until)
        console.warn('[admin-auth] account locked after repeated failures', {
          adminId: admin.id,
          lockedUntil: until.toISOString(),
          lockoutMinutes,
          failedLoginThreshold,
        })
      }
      throw new AppError(401, 'Invalid credentials', 'ADMIN_INVALID_CREDENTIALS')
    }

    // IP allow-list: CSA always; SUPER_ADMIN when env flag is on. Empty list = deny.
    if (shouldEnforceIpWhitelist(admin.role)) {
      const clientIp = normalizeIp(meta.ipAddress)
      const allowed = clientIp
        ? await systemAdminRepository.isIpWhitelisted(admin.id, clientIp)
        : false
      if (!allowed) {
        await recordLoginFailure(failKey)
        await persistFailedLogin(admin, 'ADMIN_IP_FORBIDDEN', meta)
        await systemAdminRepository.touchLastFailedLogin(admin.id).catch(() => null)
        console.warn('[admin-auth] login blocked by IP whitelist', {
          adminId: admin.id,
          role: admin.role,
          ipAddress: clientIp ?? meta.ipAddress ?? null,
        })
        throw new AppError(
          403,
          'Login not allowed from this IP address',
          'ADMIN_IP_FORBIDDEN',
        )
      }
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

    // Single-session roles: revoke peers after minting this one (new login wins).
    if (usesSingleAdminSession(admin.role)) {
      await systemAdminRepository.revokeOtherSessions(admin.id, session.id)
    }

    await systemAdminRepository.updateLastLogin(admin.id)

    return {
      accessToken: signAccessToken(
        admin.id,
        admin.role,
        usesSingleAdminSession(admin.role) ? session.id : undefined,
      ),
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

    const bindSession = usesSingleAdminSession(session.admin.role) ? session.id : undefined
    return {
      accessToken: signAccessToken(session.admin.id, session.admin.role, bindSession),
    }
  },

  async logout(adminId: string) {
    await systemAdminRepository.revokeAllSessions(adminId).catch(() => null)
    await redisClient.set(RedisKeys.adminTokenRevoked(adminId), '1', 'EX', accessTokenTtlSeconds())
  },

  /**
   * SUPER_ADMIN: set a new password for any SystemAdmin (CSA, moderator, another SUPER_ADMIN, …).
   * Revokes all sessions for the target so old JWTs stop working.
   * When `newPassword` is omitted, generates a temporary password and returns it once.
   */
  async resetPassword(params: {
    targetAdminId: string
    actorAdminId: string
    newPassword?: string
  }) {
    const target = await systemAdminRepository.findById(params.targetAdminId)
    if (!target) throw new AppError(404, 'Admin not found', 'ADMIN_NOT_FOUND')

    const plain = params.newPassword?.trim() || generateTemporaryAdminPassword()
    if (plain.length < 12) {
      throw new AppError(400, 'Password must be at least 12 characters', 'WEAK_PASSWORD')
    }
    const strength = passwordService.validateStrength(plain)
    if (!strength.ok) {
      throw new AppError(400, strength.error, 'WEAK_PASSWORD')
    }

    const passwordHash = await bcrypt.hash(plain, BCRYPT_ROUNDS)
    await systemAdminRepository.updatePasswordHash(params.targetAdminId, passwordHash)
    await this.logout(params.targetAdminId)

    // Clear email-based login throttle so the target can sign in with the new password immediately.
    await redisClient.del(RedisKeys.adminLoginFail(target.email)).catch(() => null)

    console.info('[admin-auth] password reset', {
      targetAdminId: params.targetAdminId,
      actorAdminId: params.actorAdminId,
      role: target.role,
      generated: !params.newPassword,
    })

    return {
      ok: true as const,
      adminId: target.id,
      email: target.email,
      role: target.role,
      temporaryPassword: params.newPassword ? undefined : plain,
      sessionsRevoked: true,
      message: 'Password reset; all sessions revoked',
    }
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

      // Single-session roles: access JWT must match a non-revoked AdminSession.
      if (usesSingleAdminSession(admin.role)) {
        if (!payload.sessionId) {
          throw new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID')
        }
        const session = await systemAdminRepository.findSessionById(payload.sessionId)
        if (!session || session.adminId !== admin.id) {
          throw new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID')
        }
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

function generateTemporaryAdminPassword(): string {
  const suffix = randomBytes(12)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, 'a')
  return `Aa1!${suffix}9`
}

async function recordLoginFailure(failKey: string): Promise<void> {
  try {
    const count = await redisClient.incr(failKey)
    if (count === 1) await redisClient.expire(failKey, ADMIN_LOGIN_FAIL_TTL)
  } catch {
    // Redis unavailable — fail open; the DB lockout still protects known accounts.
  }
}

function usesSingleAdminSession(role: AdminRole): boolean {
  return role === 'CUSTOMER_SUPPORT' || role === 'SUPER_ADMIN'
}

function shouldEnforceIpWhitelist(role: AdminRole): boolean {
  if (role === 'CUSTOMER_SUPPORT') return true
  if (role === 'SUPER_ADMIN') return env.SUPER_ADMIN_IP_WHITELIST_ENABLED === true
  return false
}
