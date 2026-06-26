/**
 * Security Password Management: set, change, reset flows.
 * Reuses OTPService (HMAC-SHA256), PasswordService (bcrypt 12 rounds), AuditService.
 */

import { env } from '../config/env'
import { redisClient, RedisKeys } from '../config/redis'
import { authIdentifierRepository } from '../repositories/auth-identifier.repository'
import { securityPasswordRepository } from '../repositories/security-password.repository'
import { otpAuthService } from './otp-auth.service'
import { passwordService } from './password.service'
import { auditService } from './audit.service'
import { AppError } from '../middlewares/errorHandler'

const OTP_ELIGIBLE_PROVIDERS = new Set(['email', 'phone'])
const COOLDOWN_MS = env.SECURITY_PASSWORD_LOCKOUT_DURATION_MINUTES * 60 * 1000
const RESET_TOKEN_TTL = env.SECURITY_PASSWORD_RESET_TOKEN_EXPIRY_SECONDS
const IDENTIFIERS_CACHE_TTL = 3600

type SecurityPasswordRow = NonNullable<
  Awaited<ReturnType<typeof securityPasswordRepository.findByUserId>>
>

/** Cooldown starts after N wrong PINs; expires COOLDOWN_MS after the last wrong attempt. */
function resolvePinLockout(sec: SecurityPasswordRow): {
  locked: boolean
  cooldownExpired: boolean
  retryAfterSec: number
} {
  const limit = env.SECURITY_PASSWORD_FAILED_ATTEMPTS_LIMIT
  if (sec.failedAttempts < limit || !sec.lastFailedAttemptAt) {
    return { locked: false, cooldownExpired: false, retryAfterSec: 0 }
  }

  const cooldownEndsAt = sec.lastFailedAttemptAt.getTime() + COOLDOWN_MS
  const remainingMs = cooldownEndsAt - Date.now()
  if (remainingMs <= 0) {
    return { locked: false, cooldownExpired: true, retryAfterSec: 0 }
  }

  return {
    locked: true,
    cooldownExpired: false,
    retryAfterSec: Math.ceil(remainingMs / 1000),
  }
}

export interface SecurityIdentifierView {
  id: string
  provider: string
  identifier: string
  isVerified: boolean
  maskedIdentifier: string
}

function maskIdentifier(identifier: string): string {
  if (identifier.includes('@')) {
    const [local, domain] = identifier.split('@')
    return `${local.slice(0, 2)}***@${domain}`
  }
  return `${identifier.slice(0, 3)}****${identifier.slice(-4)}`
}

export const securityPasswordService = {
  async getIdentifiers(userId: string): Promise<SecurityIdentifierView[]> {
    const cacheKey = RedisKeys.userSecurityIdentifiers(userId)
    const cached = await redisClient.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached) as SecurityIdentifierView[]
      } catch {
        // invalid cache, fall through to DB
      }
    }

    const rows = await authIdentifierRepository.findByUserId(userId)
    const eligible = rows.filter((r) => OTP_ELIGIBLE_PROVIDERS.has(r.provider))
    const result: SecurityIdentifierView[] = eligible.map((r) => ({
      id: r.id,
      provider: r.provider,
      identifier: r.identifier,
      isVerified: r.isVerified,
      maskedIdentifier: maskIdentifier(r.identifier),
    }))
    await redisClient.set(cacheKey, JSON.stringify(result), 'EX', IDENTIFIERS_CACHE_TTL)
    return result
  },

  async isSecurityPinSet(userId: string): Promise<boolean> {
    const sec = await securityPasswordRepository.findByUserId(userId)
    return sec != null
  },

  async sendOtpForPassword(
    userId: string,
    identifierId: string,
  ): Promise<{ otpSent: boolean; expiresIn: number; maskedIdentifier: string; purpose: string }> {
    const identifier = await authIdentifierRepository.findById(identifierId)
    if (!identifier || identifier.userId !== userId) {
      throw new AppError(404, 'Auth identifier not found', 'IDENTIFIER_NOT_FOUND')
    }
    if (!OTP_ELIGIBLE_PROVIDERS.has(identifier.provider)) {
      throw new AppError(400, 'Identifier cannot receive OTP', 'INVALID_IDENTIFIER')
    }

    await otpAuthService.createAndStore({
      targetIdentifier: identifier.identifier,
      purpose: 'set_security_password',
      userId,
    })

    await auditService.log({
      userId,
      actionType: 'SECURITY_PASSWORD_OTP_SENT',
      actionStatus: 'success',
      actionDetails: { identifierId },
    })

    return {
      otpSent: true,
      expiresIn: 300,
      maskedIdentifier: maskIdentifier(identifier.identifier),
      purpose: 'security_password',
    }
  },

  async verifyOtpForPassword(
    userId: string,
    identifierId: string,
    otp: string,
  ): Promise<{ otpVerified: boolean; resetToken: string; expiresIn: number; nextStep: string }> {
    const identifier = await authIdentifierRepository.findById(identifierId)
    if (!identifier || identifier.userId !== userId) {
      throw new AppError(404, 'Auth identifier not found', 'IDENTIFIER_NOT_FOUND')
    }

    const verified = await otpAuthService.verify({
      targetIdentifier: identifier.identifier,
      purpose: 'set_security_password',
      otp,
      userId,
    })
    if (!verified) {
      await auditService.log({
        userId,
        actionType: 'SECURITY_PASSWORD_OTP_VERIFIED',
        actionStatus: 'failed',
        actionDetails: { identifierId },
      })
      throw new AppError(400, 'Invalid or expired OTP', 'INVALID_OTP')
    }

    const resetToken = crypto.randomUUID()
    const key = RedisKeys.securityPasswordResetToken(resetToken)
    await redisClient.set(key, userId, 'EX', RESET_TOKEN_TTL)

    await auditService.log({
      userId,
      actionType: 'SECURITY_PASSWORD_OTP_VERIFIED',
      actionStatus: 'success',
      actionDetails: { identifierId },
    })

    return {
      otpVerified: true,
      resetToken,
      expiresIn: RESET_TOKEN_TTL,
      nextStep: 'set_password',
    }
  },

  async setPin(userId: string, resetToken: string, newPin: string): Promise<{ setAt: Date }> {
    const key = RedisKeys.securityPasswordResetToken(resetToken)
    const tokenUserId = await redisClient.get(key)
    if (!tokenUserId || tokenUserId !== userId) {
      throw new AppError(400, 'Invalid or expired reset token', 'INVALID_REQUEST')
    }

    const passwordHash = await passwordService.hash(newPin)
    const record = await securityPasswordRepository.upsert({
      userId,
      passwordHash,
      failedAttempts: 0,
      lockedUntil: null,
    })

    await redisClient.del(key)
    await invalidateSecurityPasswordCache(userId)

    await auditService.log({
      userId,
      actionType: 'SECURITY_PASSWORD_SET',
      actionStatus: 'success',
    })

    return { setAt: record.setAt }
  },

  async verifyCurrentPassword(userId: string, currentPassword: string): Promise<void> {
    let sec = await securityPasswordRepository.findByUserId(userId)
    if (!sec) {
      throw new AppError(400, 'Security password not set yet', 'SECURITY_PASSWORD_NOT_SET')
    }

    const lockout = resolvePinLockout(sec)
    if (lockout.cooldownExpired) {
      await securityPasswordRepository.resetFailedAttempts(userId)
      sec = { ...sec, failedAttempts: 0, lockedUntil: null, lastFailedAttemptAt: null }
    } else if (lockout.locked) {
      throw new AppError(
        429,
        `Too many failed attempts. Try again after ${env.SECURITY_PASSWORD_LOCKOUT_DURATION_MINUTES} minutes.`,
        'PASSWORD_LOCKED',
        {
          retryAfter: lockout.retryAfterSec,
          lockoutMinutes: env.SECURITY_PASSWORD_LOCKOUT_DURATION_MINUTES,
        },
      )
    }

    const match = await passwordService.compare(currentPassword, sec.passwordHash)
    if (!match) {
      const failedAttempts = sec.failedAttempts + 1
      const lastFailedAttemptAt = new Date()
      const update: {
        failedAttempts: number
        lastFailedAttemptAt: Date
        lockedUntil: Date | null
      } = {
        failedAttempts,
        lastFailedAttemptAt,
        lockedUntil:
          failedAttempts >= env.SECURITY_PASSWORD_FAILED_ATTEMPTS_LIMIT
            ? new Date(lastFailedAttemptAt.getTime() + COOLDOWN_MS)
            : null,
      }
      await securityPasswordRepository.update(userId, update)

      await auditService.log({
        userId,
        actionType: 'SECURITY_PASSWORD_VERIFY_FAILED',
        actionStatus: 'failed',
        actionDetails: { attemptNumber: failedAttempts },
      })
      throw new AppError(403, 'Incorrect security password', 'SECURITY_PASSWORD_INCORRECT')
    }

    await securityPasswordRepository.resetFailedAttempts(userId)
  },

  async changePin(
    userId: string,
    currentPin: string,
    newPin: string,
  ): Promise<{ changedAt: Date }> {
    await this.verifyCurrentPassword(userId, currentPin)

    const passwordHash = await passwordService.hash(newPin)
    const record = await securityPasswordRepository.update(userId, {
      passwordHash,
      failedAttempts: 0,
      lockedUntil: null,
    })

    await invalidateSecurityPasswordCache(userId)

    await auditService.log({
      userId,
      actionType: 'SECURITY_PASSWORD_CHANGED',
      actionStatus: 'success',
    })

    return { changedAt: record.updatedAt }
  },

  async resetPassword(
    userId: string,
    identifierId: string,
    otp: string,
    newPin: string,
  ): Promise<{ success: true; message: string }> {
    const identifier = await authIdentifierRepository.findById(identifierId)
    if (!identifier || identifier.userId !== userId) {
      throw new AppError(404, 'Auth identifier not found', 'IDENTIFIER_NOT_FOUND')
    }

    const verified = await otpAuthService.verify({
      targetIdentifier: identifier.identifier,
      purpose: 'set_security_password',
      otp,
      userId,
    })
    if (!verified) {
      throw new AppError(400, 'Invalid or expired OTP', 'INVALID_OTP')
    }

    const passwordHash = await passwordService.hash(newPin)
    await securityPasswordRepository.upsert({
      userId,
      passwordHash,
      failedAttempts: 0,
      lockedUntil: null,
    })

    await invalidateSecurityPasswordCache(userId)

    await auditService.log({
      userId,
      actionType: 'SECURITY_PASSWORD_RESET',
      actionStatus: 'success',
      actionDetails: { identifierId },
    })

    return { success: true, message: 'Security password reset successfully' }
  },
}

async function invalidateSecurityPasswordCache(userId: string): Promise<void> {
  await redisClient.del(RedisKeys.userSecurityIdentifiers(userId))
  await redisClient.del(RedisKeys.userSecurityPasswordExists(userId))
  await redisClient.del(RedisKeys.userSecurityPasswordLocked(userId))
}
