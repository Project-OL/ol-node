import { describe, it, expect, vi, beforeEach } from 'vitest'

const findById = vi.fn()
vi.mock('../../src/repositories/auth-identifier.repository', () => ({
  authIdentifierRepository: { findById: (...a: unknown[]) => findById(...a) },
}))
const createAndStore = vi.fn()
vi.mock('../../src/services/otp-auth.service', () => ({
  otpAuthService: {
    createAndStore: (...a: unknown[]) => createAndStore(...a),
    verify: vi.fn(),
  },
}))
const auditLog = vi.fn()
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...a: unknown[]) => auditLog(...a) },
}))
vi.mock('../../src/repositories/security-password.repository', () => ({
  securityPasswordRepository: { findByUserId: vi.fn() },
}))
vi.mock('../../src/services/password.service', () => ({
  passwordService: { compare: vi.fn(), hash: vi.fn(), validateStrength: vi.fn() },
}))
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: { findById: vi.fn() },
}))

const redisSet = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    set: (...a: unknown[]) => redisSet(...a),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn(),
  },
  RedisKeys: {
    userSecurityIdentifiers: (id: string) => `user:${id}:security:identifiers`,
    userSecurityPasswordExists: (id: string) => `user:${id}:security:password:exists`,
    userSecurityPasswordLocked: (id: string) => `user:${id}:security:password:locked`,
    securityPasswordResetToken: (t: string) => `security:password:reset-token:${t}`,
    securityPasswordChangeToken: (t: string) => `security:password:change-token:${t}`,
  },
}))

const { securityPasswordService } = await import('../../src/services/security-password.service')

describe('securityPasswordService.sendOtpForPassword burst single-flight', () => {
  beforeEach(() => {
    findById.mockReset().mockResolvedValue({
      id: 'ident-1',
      userId: 'u1',
      provider: 'email',
      identifier: 'user@example.com',
    })
    createAndStore.mockReset().mockResolvedValue({ expiresAt: new Date() })
    auditLog.mockReset().mockResolvedValue(undefined)
    redisSet.mockReset()
  })

  it('first request in a burst sends the OTP', async () => {
    redisSet.mockResolvedValue('OK')
    const out = await securityPasswordService.sendOtpForPassword('u1', 'ident-1')
    expect(createAndStore).toHaveBeenCalledTimes(1)
    expect(out.otpSent).toBe(true)
  })

  it('duplicate within the guard window returns the same body without a second delivery', async () => {
    redisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null)
    const first = await securityPasswordService.sendOtpForPassword('u1', 'ident-1')
    const second = await securityPasswordService.sendOtpForPassword('u1', 'ident-1')
    expect(createAndStore).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('sends normally when Redis is unavailable (guard is best-effort)', async () => {
    redisSet.mockRejectedValue(new Error('redis down'))
    const out = await securityPasswordService.sendOtpForPassword('u1', 'ident-1')
    expect(createAndStore).toHaveBeenCalledTimes(1)
    expect(out.otpSent).toBe(true)
  })
})
