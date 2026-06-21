import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisGet = vi.fn()
const redisSet = vi.fn()
const redisDel = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    get: (...args: unknown[]) => redisGet(...args),
    set: (...args: unknown[]) => redisSet(...args),
    del: (...args: unknown[]) => redisDel(...args),
  },
  RedisKeys: {
    userSecurityIdentifiers: (userId: string) => `user:${userId}:security:identifiers`,
    securityPasswordResetToken: (t: string) => `security:password:reset-token:${t}`,
    userSecurityPasswordExists: (userId: string) => `user:${userId}:security:password:exists`,
    userSecurityPasswordLocked: (userId: string) => `user:${userId}:security:password:locked`,
  },
}))

vi.mock('../../src/config/env', () => ({
  env: {
    SECURITY_PASSWORD_FAILED_ATTEMPTS_LIMIT: 8,
    SECURITY_PASSWORD_LOCKOUT_DURATION_MINUTES: 10,
    SECURITY_PASSWORD_RESET_TOKEN_EXPIRY_SECONDS: 600,
  },
}))

const findByUserId = vi.fn()
const findById = vi.fn()
vi.mock('../../src/repositories/auth-identifier.repository', () => ({
  authIdentifierRepository: {
    findByUserId: (...args: unknown[]) => findByUserId(...args),
    findById: (...args: unknown[]) => findById(...args),
  },
}))

const secFindByUserId = vi.fn()
const secUpsert = vi.fn()
const secUpdate = vi.fn()
const secResetFailedAttempts = vi.fn()
vi.mock('../../src/repositories/security-password.repository', () => ({
  securityPasswordRepository: {
    findByUserId: (...args: unknown[]) => secFindByUserId(...args),
    upsert: (...args: unknown[]) => secUpsert(...args),
    update: (...args: unknown[]) => secUpdate(...args),
    resetFailedAttempts: (...args: unknown[]) => secResetFailedAttempts(...args),
  },
}))

const otpCreateAndStore = vi.fn().mockResolvedValue(undefined)
const otpVerify = vi.fn().mockResolvedValue(true)
vi.mock('../../src/services/otp-auth.service', () => ({
  otpAuthService: {
    createAndStore: (...args: unknown[]) => otpCreateAndStore(...args),
    verify: (...args: unknown[]) => otpVerify(...args),
  },
}))

const passwordHash = vi.fn().mockResolvedValue('hashed')
const passwordCompare = vi.fn().mockResolvedValue(true)
const passwordValidateStrength = vi.fn().mockReturnValue({ ok: true })
vi.mock('../../src/services/password.service', () => ({
  passwordService: {
    hash: (...args: unknown[]) => passwordHash(...args),
    compare: (...args: unknown[]) => passwordCompare(...args),
    validateStrength: (...args: unknown[]) => passwordValidateStrength(...args),
  },
}))

vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}))

const { securityPasswordService } = await import('../../src/services/security-password.service')

const userId = 'user-123'
const identifierId = 'auth-id-456'
const verifiedIdentifier = {
  id: identifierId,
  userId,
  provider: 'email',
  identifier: 'user@example.com',
  isVerified: true,
}

describe('securityPasswordService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisGet.mockResolvedValue(null)
    redisSet.mockResolvedValue(undefined)
    redisDel.mockResolvedValue(undefined)
    otpVerify.mockResolvedValue(true)
    passwordCompare.mockResolvedValue(true)
    passwordValidateStrength.mockReturnValue({ ok: true })
  })

  describe('getIdentifiers', () => {
    it('returns verified identifiers from DB and caches them', async () => {
      findByUserId.mockResolvedValue([
        { id: identifierId, userId, provider: 'email', identifier: 'user@example.com', isVerified: true },
      ])

      const result = await securityPasswordService.getIdentifiers(userId)

      expect(result).toHaveLength(1)
      expect(result[0].maskedIdentifier).toMatch(/^\w\w\*\*\*@/)
      expect(redisSet).toHaveBeenCalledWith(
        `user:${userId}:security:identifiers`,
        expect.any(String),
        'EX',
        3600,
      )
    })

    it('returns cached identifiers when present', async () => {
      const cached = [
        { id: identifierId, provider: 'email', identifier: 'x@y.com', isVerified: true, maskedIdentifier: 'xy***@y.com' },
      ]
      redisGet.mockResolvedValue(JSON.stringify(cached))

      const result = await securityPasswordService.getIdentifiers(userId)

      expect(result).toEqual(cached)
      expect(findByUserId).not.toHaveBeenCalled()
    })

    it('returns all email and phone identifiers (not only isVerified)', async () => {
      findByUserId.mockResolvedValue([
        { id: '1', userId, provider: 'email', identifier: 'a@b.com', isVerified: true },
        { id: '2', userId, provider: 'phone', identifier: '+1234567890', isVerified: false },
        { id: '3', userId, provider: 'google', identifier: 'google-sub', isVerified: true },
      ])

      const result = await securityPasswordService.getIdentifiers(userId)

      expect(result).toHaveLength(2)
      expect(result.map((r) => r.provider)).toEqual(['email', 'phone'])
    })
  })

  describe('isSecurityPinSet', () => {
    it('returns false when no security password row', async () => {
      secFindByUserId.mockResolvedValue(null)
      await expect(securityPasswordService.isSecurityPinSet(userId)).resolves.toBe(false)
    })

    it('returns true when row exists', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 0,
        lockedUntil: null,
      })
      await expect(securityPasswordService.isSecurityPinSet(userId)).resolves.toBe(true)
    })
  })

  describe('sendOtpForPassword', () => {
    it('sends OTP for valid verified identifier', async () => {
      findById.mockResolvedValue(verifiedIdentifier)

      const result = await securityPasswordService.sendOtpForPassword(userId, identifierId)

      expect(result.otpSent).toBe(true)
      expect(result.expiresIn).toBe(300)
      expect(result.purpose).toBe('security_password')
      expect(otpCreateAndStore).toHaveBeenCalledWith({
        targetIdentifier: 'user@example.com',
        purpose: 'set_security_password',
        userId,
      })
    })

    it('throws IDENTIFIER_NOT_FOUND when identifier missing', async () => {
      findById.mockResolvedValue(null)

      await expect(securityPasswordService.sendOtpForPassword(userId, identifierId)).rejects.toMatchObject({
        code: 'IDENTIFIER_NOT_FOUND',
        statusCode: 404,
      })
    })

    it('sends OTP for unverified email or phone bound to user', async () => {
      findById.mockResolvedValue({ ...verifiedIdentifier, isVerified: false })

      const result = await securityPasswordService.sendOtpForPassword(userId, identifierId)

      expect(result.otpSent).toBe(true)
      expect(otpCreateAndStore).toHaveBeenCalled()
    })

    it('throws INVALID_IDENTIFIER for non-OTP providers', async () => {
      findById.mockResolvedValue({ ...verifiedIdentifier, provider: 'google', identifier: 'sub-1' })

      await expect(securityPasswordService.sendOtpForPassword(userId, identifierId)).rejects.toMatchObject({
        code: 'INVALID_IDENTIFIER',
        statusCode: 400,
      })
    })
  })

  describe('verifyOtpForPassword', () => {
    it('returns reset token when OTP valid', async () => {
      findById.mockResolvedValue(verifiedIdentifier)
      otpVerify.mockResolvedValue(true)

      const result = await securityPasswordService.verifyOtpForPassword(userId, identifierId, '12345')

      expect(result.otpVerified).toBe(true)
      expect(result.nextStep).toBe('set_password')
      expect(result.resetToken).toBeDefined()
      expect(result.expiresIn).toBe(600)
      expect(redisSet).toHaveBeenCalled()
    })

    it('throws INVALID_OTP when OTP invalid', async () => {
      findById.mockResolvedValue(verifiedIdentifier)
      otpVerify.mockResolvedValue(false)

      await expect(
        securityPasswordService.verifyOtpForPassword(userId, identifierId, '12345'),
      ).rejects.toMatchObject({ code: 'INVALID_OTP', statusCode: 400 })
    })
  })

  describe('setPin', () => {
    it('stores PIN when reset token valid', async () => {
      const resetToken = 'token-xyz'
      redisGet.mockResolvedValue(userId)
      secUpsert.mockResolvedValue({ setAt: new Date() })

      const result = await securityPasswordService.setPin(userId, resetToken, '123456')

      expect(result.setAt).toBeDefined()
      expect(passwordValidateStrength).not.toHaveBeenCalled()
      expect(passwordHash).toHaveBeenCalledWith('123456')
      expect(secUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ userId, passwordHash: 'hashed', failedAttempts: 0, lockedUntil: null }),
      )
      expect(redisDel).toHaveBeenCalled()
    })

    it('throws INVALID_REQUEST when reset token missing or wrong user', async () => {
      redisGet.mockResolvedValue(null)

      await expect(
        securityPasswordService.setPin(userId, 'bad-token', '123456'),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST', statusCode: 400 })
    })
  })

  describe('verifyCurrentPassword', () => {
    it('resets failed attempts when password correct', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 0,
        lockedUntil: null,
      })

      await securityPasswordService.verifyCurrentPassword(userId, '123456')

      expect(passwordCompare).toHaveBeenCalledWith('123456', 'hash')
      expect(secResetFailedAttempts).toHaveBeenCalledWith(userId)
    })

    it('throws SECURITY_PASSWORD_NOT_SET when no record', async () => {
      secFindByUserId.mockResolvedValue(null)

      await expect(
        securityPasswordService.verifyCurrentPassword(userId, '123456'),
      ).rejects.toMatchObject({ code: 'SECURITY_PASSWORD_NOT_SET', statusCode: 400 })
    })

    it('throws PASSWORD_LOCKED when cooldown active after limit reached', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 8,
        lastFailedAttemptAt: new Date(Date.now() - 60_000),
        lockedUntil: new Date(Date.now() + 540_000),
      })

      await expect(
        securityPasswordService.verifyCurrentPassword(userId, '123456'),
      ).rejects.toMatchObject({ code: 'PASSWORD_LOCKED', statusCode: 429 })
    })

    it('clears cooldown after 10 minutes from last wrong attempt and accepts correct PIN', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 8,
        lastFailedAttemptAt: new Date(Date.now() - 11 * 60_000),
        lockedUntil: new Date(Date.now() - 60_000),
      })

      await securityPasswordService.verifyCurrentPassword(userId, '123456')

      expect(secResetFailedAttempts).toHaveBeenCalledWith(userId)
      expect(passwordCompare).toHaveBeenCalledWith('123456', 'hash')
    })

    it('increments failed attempts and throws SECURITY_PASSWORD_INCORRECT when wrong', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 0,
        lockedUntil: null,
      })
      passwordCompare.mockResolvedValue(false)

      await expect(
        securityPasswordService.verifyCurrentPassword(userId, '999999'),
      ).rejects.toMatchObject({ code: 'SECURITY_PASSWORD_INCORRECT', statusCode: 401 })

      expect(secUpdate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ failedAttempts: 1, lastFailedAttemptAt: expect.any(Date) }),
      )
    })

    it('sets cooldown end from last failed attempt when limit reached', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 7,
        lockedUntil: null,
        lastFailedAttemptAt: null,
      })
      passwordCompare.mockResolvedValue(false)

      await expect(
        securityPasswordService.verifyCurrentPassword(userId, '999999'),
      ).rejects.toMatchObject({ code: 'SECURITY_PASSWORD_INCORRECT' })

      expect(secUpdate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          failedAttempts: 8,
          lastFailedAttemptAt: expect.any(Date),
          lockedUntil: expect.any(Date),
        }),
      )
    })
  })

  describe('changePin', () => {
    it('updates PIN when current PIN is correct', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 0,
        lockedUntil: null,
      })
      secUpdate.mockResolvedValue({ updatedAt: new Date() })

      const result = await securityPasswordService.changePin(userId, '123456', '654321')

      expect(result.changedAt).toBeDefined()
      expect(passwordValidateStrength).not.toHaveBeenCalled()
      expect(passwordHash).toHaveBeenCalledWith('654321')
      expect(secUpdate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ passwordHash: 'hashed', failedAttempts: 0, lockedUntil: null }),
      )
      expect(redisDel).toHaveBeenCalled()
    })

    it('throws SECURITY_PASSWORD_INCORRECT when current PIN wrong', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 0,
        lockedUntil: null,
      })
      passwordCompare.mockResolvedValue(false)

      await expect(
        securityPasswordService.changePin(userId, '111111', '654321'),
      ).rejects.toMatchObject({ code: 'SECURITY_PASSWORD_INCORRECT' })

      expect(secUpdate).not.toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ passwordHash: 'hashed' }),
      )
    })
  })

  describe('resetPassword', () => {
    it('resets PIN when OTP valid', async () => {
      findById.mockResolvedValue(verifiedIdentifier)
      otpVerify.mockResolvedValue(true)
      secUpsert.mockResolvedValue({})

      const result = await securityPasswordService.resetPassword(userId, identifierId, '12345', '987654')

      expect(result.success).toBe(true)
      expect(result.message).toBe('Security password reset successfully')
      expect(passwordValidateStrength).not.toHaveBeenCalled()
      expect(passwordHash).toHaveBeenCalledWith('987654')
      expect(secUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ userId, passwordHash: 'hashed', failedAttempts: 0, lockedUntil: null }),
      )
    })

    it('throws INVALID_OTP when OTP invalid', async () => {
      findById.mockResolvedValue(verifiedIdentifier)
      otpVerify.mockResolvedValue(false)

      await expect(
        securityPasswordService.resetPassword(userId, identifierId, '00000', '987654'),
      ).rejects.toMatchObject({ code: 'INVALID_OTP' })
    })

    it('throws IDENTIFIER_NOT_FOUND when identifier wrong', async () => {
      findById.mockResolvedValue(null)

      await expect(
        securityPasswordService.resetPassword(userId, identifierId, '12345', '987654'),
      ).rejects.toMatchObject({ code: 'IDENTIFIER_NOT_FOUND' })
    })
  })
})
