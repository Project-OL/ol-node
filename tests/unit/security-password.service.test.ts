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
    securityPasswordChangeToken: (t: string) => `security:password:change-token:${t}`,
    userSecurityPasswordExists: (userId: string) => `user:${userId}:security:password:exists`,
    userSecurityPasswordLocked: (userId: string) => `user:${userId}:security:password:locked`,
  },
}))

vi.mock('../../src/config/env', () => ({
  env: {
    SECURITY_PASSWORD_FAILED_ATTEMPTS_LIMIT: 3,
    SECURITY_PASSWORD_LOCKOUT_DURATION_MINUTES: 60,
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

    it('filters to verified only', async () => {
      findByUserId.mockResolvedValue([
        { id: '1', userId, provider: 'email', identifier: 'a@b.com', isVerified: true },
        { id: '2', userId, provider: 'phone', identifier: '+123', isVerified: false },
      ])

      const result = await securityPasswordService.getIdentifiers(userId)

      expect(result).toHaveLength(1)
      expect(result[0].provider).toBe('email')
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

    it('throws IDENTIFIER_NOT_FOUND when identifier belongs to another user', async () => {
      findById.mockResolvedValue({ ...verifiedIdentifier, userId: 'other-user' })

      await expect(securityPasswordService.sendOtpForPassword(userId, identifierId)).rejects.toMatchObject({
        code: 'IDENTIFIER_NOT_FOUND',
      })
    })

    it('throws IDENTIFIER_NOT_VERIFIED when not verified', async () => {
      findById.mockResolvedValue({ ...verifiedIdentifier, isVerified: false })

      await expect(securityPasswordService.sendOtpForPassword(userId, identifierId)).rejects.toMatchObject({
        code: 'IDENTIFIER_NOT_VERIFIED',
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

    it('throws IDENTIFIER_NOT_FOUND when identifier missing', async () => {
      findById.mockResolvedValue(null)

      await expect(
        securityPasswordService.verifyOtpForPassword(userId, identifierId, '12345'),
      ).rejects.toMatchObject({ code: 'IDENTIFIER_NOT_FOUND' })
    })
  })

  describe('setPassword', () => {
    it('sets password and clears token when reset token valid', async () => {
      const resetToken = 'token-xyz'
      redisGet.mockResolvedValue(userId)
      secUpsert.mockResolvedValue({ setAt: new Date() })

      const result = await securityPasswordService.setPassword(userId, resetToken, 'NewP@ss1!')

      expect(result.setAt).toBeDefined()
      expect(passwordValidateStrength).toHaveBeenCalledWith('NewP@ss1!')
      expect(passwordHash).toHaveBeenCalledWith('NewP@ss1!')
      expect(secUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ userId, passwordHash: 'hashed', failedAttempts: 0, lockedUntil: null }),
      )
      expect(redisDel).toHaveBeenCalled()
    })

    it('throws INVALID_REQUEST when reset token missing or wrong user', async () => {
      redisGet.mockResolvedValue(null)

      await expect(
        securityPasswordService.setPassword(userId, 'bad-token', 'NewP@ss1!'),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST', statusCode: 400 })
    })

    it('throws PASSWORD_WEAK when validation fails', async () => {
      redisGet.mockResolvedValue(userId)
      passwordValidateStrength.mockReturnValue({ ok: false, error: 'Too weak' })

      await expect(
        securityPasswordService.setPassword(userId, 'token', 'weak'),
      ).rejects.toMatchObject({ code: 'PASSWORD_WEAK', statusCode: 400 })
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

      await securityPasswordService.verifyCurrentPassword(userId, 'CorrectP@ss1!')

      expect(passwordCompare).toHaveBeenCalledWith('CorrectP@ss1!', 'hash')
      expect(secResetFailedAttempts).toHaveBeenCalledWith(userId)
    })

    it('throws SECURITY_PASSWORD_NOT_SET when no record', async () => {
      secFindByUserId.mockResolvedValue(null)

      await expect(
        securityPasswordService.verifyCurrentPassword(userId, 'AnyP@ss1!'),
      ).rejects.toMatchObject({ code: 'SECURITY_PASSWORD_NOT_SET', statusCode: 400 })
    })

    it('throws PASSWORD_LOCKED when lockedUntil in future', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 3,
        lockedUntil: new Date(Date.now() + 3600000),
      })

      await expect(
        securityPasswordService.verifyCurrentPassword(userId, 'AnyP@ss1!'),
      ).rejects.toMatchObject({ code: 'PASSWORD_LOCKED', statusCode: 429 })
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
        securityPasswordService.verifyCurrentPassword(userId, 'WrongP@ss1!'),
      ).rejects.toMatchObject({ code: 'SECURITY_PASSWORD_INCORRECT', statusCode: 401 })

      expect(secUpdate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ failedAttempts: 1, lastFailedAttemptAt: expect.any(Date) }),
      )
    })

    it('sets lockedUntil when failed attempts reach limit', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 2,
        lockedUntil: null,
      })
      passwordCompare.mockResolvedValue(false)

      await expect(
        securityPasswordService.verifyCurrentPassword(userId, 'WrongP@ss1!'),
      ).rejects.toMatchObject({ code: 'SECURITY_PASSWORD_INCORRECT' })

      expect(secUpdate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          failedAttempts: 3,
          lockedUntil: expect.any(Date),
        }),
      )
    })
  })

  describe('startChangePassword', () => {
    it('returns changeToken and identifiers when current password correct', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 0,
        lockedUntil: null,
      })
      findByUserId.mockResolvedValue([
        { id: identifierId, userId, provider: 'email', identifier: 'u@e.com', isVerified: true },
      ])

      const result = await securityPasswordService.startChangePassword(userId, 'CurrentP@ss1!')

      expect(result.changeToken).toBeDefined()
      expect(result.identifiers).toHaveLength(1)
      expect(result.expiresIn).toBe(600)
      expect(redisSet).toHaveBeenCalled()
    })

    it('throws when no verified identifiers', async () => {
      secFindByUserId.mockResolvedValue({
        userId,
        passwordHash: 'hash',
        failedAttempts: 0,
        lockedUntil: null,
      })
      findByUserId.mockResolvedValue([])

      await expect(
        securityPasswordService.startChangePassword(userId, 'CurrentP@ss1!'),
      ).rejects.toMatchObject({ code: 'IDENTIFIER_NOT_FOUND', statusCode: 400 })
    })
  })

  describe('sendOtpForChange', () => {
    it('sends OTP when change token valid', async () => {
      redisGet.mockResolvedValue(userId)
      findById.mockResolvedValue(verifiedIdentifier)

      const result = await securityPasswordService.sendOtpForChange(userId, 'change-token', identifierId)

      expect(result.otpSent).toBe(true)
      expect(result.expiresIn).toBe(300)
      expect(otpCreateAndStore).toHaveBeenCalled()
      expect(redisSet).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining(userId),
        'EX',
        600,
      )
    })

    it('throws INVALID_REQUEST when change token invalid', async () => {
      redisGet.mockResolvedValue(null)

      await expect(
        securityPasswordService.sendOtpForChange(userId, 'bad-token', identifierId),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    })
  })

  describe('confirmChangePassword', () => {
    it('updates password and clears token when OTP and token valid', async () => {
      const changeToken = 'ct-123'
      redisGet.mockResolvedValue(JSON.stringify({ userId, identifierId }))
      findById.mockResolvedValue(verifiedIdentifier)
      otpVerify.mockResolvedValue(true)
      secUpdate.mockResolvedValue({ updatedAt: new Date() })

      const result = await securityPasswordService.confirmChangePassword(
        userId,
        changeToken,
        '12345',
        'NewP@ss1!',
      )

      expect(result.changedAt).toBeDefined()
      expect(passwordHash).toHaveBeenCalledWith('NewP@ss1!')
      expect(secUpdate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ passwordHash: 'hashed', failedAttempts: 0, lockedUntil: null }),
      )
      expect(redisDel).toHaveBeenCalled()
    })

    it('throws INVALID_REQUEST when token missing', async () => {
      redisGet.mockResolvedValue(null)

      await expect(
        securityPasswordService.confirmChangePassword(userId, 'bad', '12345', 'NewP@ss1!'),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    })

    it('throws INVALID_OTP when OTP wrong', async () => {
      redisGet.mockResolvedValue(JSON.stringify({ userId, identifierId }))
      findById.mockResolvedValue(verifiedIdentifier)
      otpVerify.mockResolvedValue(false)

      await expect(
        securityPasswordService.confirmChangePassword(userId, 'ct', '00000', 'NewP@ss1!'),
      ).rejects.toMatchObject({ code: 'INVALID_OTP' })
    })
  })

  describe('resetPassword', () => {
    it('resets password when OTP valid', async () => {
      findById.mockResolvedValue(verifiedIdentifier)
      otpVerify.mockResolvedValue(true)
      secUpsert.mockResolvedValue({})

      const result = await securityPasswordService.resetPassword(
        userId,
        identifierId,
        '12345',
        'NewP@ss1!',
      )

      expect(result.success).toBe(true)
      expect(result.message).toBe('Security password reset successfully')
      expect(passwordHash).toHaveBeenCalledWith('NewP@ss1!')
      expect(secUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ userId, passwordHash: 'hashed', failedAttempts: 0, lockedUntil: null }),
      )
    })

    it('throws INVALID_OTP when OTP invalid', async () => {
      findById.mockResolvedValue(verifiedIdentifier)
      otpVerify.mockResolvedValue(false)

      await expect(
        securityPasswordService.resetPassword(userId, identifierId, '00000', 'NewP@ss1!'),
      ).rejects.toMatchObject({ code: 'INVALID_OTP' })
    })

    it('throws IDENTIFIER_NOT_FOUND when identifier wrong', async () => {
      findById.mockResolvedValue(null)

      await expect(
        securityPasswordService.resetPassword(userId, identifierId, '12345', 'NewP@ss1!'),
      ).rejects.toMatchObject({ code: 'IDENTIFIER_NOT_FOUND' })
    })
  })
})
