import { describe, it, expect, vi, beforeEach } from 'vitest'
import { otpAuthService } from '../../src/services/otp-auth.service'

vi.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'test-secret-at-least-32-characters-long',
    STATIC_OTP_DEV: undefined,
  },
}))

vi.mock('../../src/repositories/otp-token.repository', () => ({
  otpTokenRepository: {
    create: vi.fn().mockResolvedValue({ id: 'otp-1', expiresAt: new Date() }),
    findValid: vi.fn(),
    markUsed: vi.fn().mockResolvedValue(undefined),
    incrementAttempt: vi.fn().mockResolvedValue(undefined),
  },
}))

const deliverySend = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/otp-delivery.service', () => ({
  maskOtpTargetIdentifier: (target: string) => `masked:${target}`,
  otpDeliveryService: {
    send: (...args: unknown[]) => deliverySend(...args),
  },
}))

const auditLog = vi.fn()
vi.mock('../../src/services/audit.service', () => ({
  auditService: {
    log: (...args: unknown[]) => auditLog(...args),
  },
}))

const { otpTokenRepository } = await import('../../src/repositories/otp-token.repository')

describe('otpAuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createAndStore', () => {
    it('stores HMAC hash of generated OTP and returns expiresAt', async () => {
      const result = await otpAuthService.createAndStore({
        targetIdentifier: 'user@example.com',
        purpose: 'signup',
      })
      expect(result.expiresAt).toBeInstanceOf(Date)
      expect(otpTokenRepository.create).toHaveBeenCalledTimes(1)
      const call = vi.mocked(otpTokenRepository.create).mock.calls[0][0]
      expect(call.otpHash).toBeDefined()
      expect(call.otpHash).toMatch(/^[a-f0-9]{64}$/)
      expect(call.otpPurpose).toBe('signup')
      expect(call.targetIdentifier).toBe('user@example.com')
      expect(deliverySend).toHaveBeenCalledWith({
        otp: expect.stringMatching(/^\d{5}$/),
        targetIdentifier: 'user@example.com',
        purpose: 'signup',
      })
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'OTP_GENERATED',
          actionStatus: 'success',
        }),
      )
    })
  })

  describe('verify', () => {
    it('returns false when no valid record', async () => {
      vi.mocked(otpTokenRepository.findValid).mockResolvedValue(null)
      const ok = await otpAuthService.verify({
        targetIdentifier: 'user@example.com',
        purpose: 'signup',
        otp: '12345',
      })
      expect(ok).toBe(false)
    })

    it('returns true when OTP matches stored HMAC', async () => {
      const { createHmac } = await import('crypto')
      const secret = 'test-secret-at-least-32-characters-long'
      const otp = '54321'
      const hash = createHmac('sha256', secret).update(otp).digest('hex')
      vi.mocked(otpTokenRepository.findValid).mockResolvedValue({
        id: 'rec-1',
        otpHash: hash,
        targetIdentifier: 'user@example.com',
        otpPurpose: 'signup',
      } as never)
      const ok = await otpAuthService.verify({
        targetIdentifier: 'user@example.com',
        purpose: 'signup',
        otp: '54321',
      })
      expect(ok).toBe(true)
    })

    it('returns false when OTP does not match', async () => {
      const { createHmac } = await import('crypto')
      const secret = 'test-secret-at-least-32-characters-long'
      const hash = createHmac('sha256', secret).update('11111').digest('hex')
      vi.mocked(otpTokenRepository.findValid).mockResolvedValue({
        id: 'rec-1',
        otpHash: hash,
        targetIdentifier: 'user@example.com',
        otpPurpose: 'signup',
      } as never)
      const ok = await otpAuthService.verify({
        targetIdentifier: 'user@example.com',
        purpose: 'signup',
        otp: '99999',
      })
      expect(ok).toBe(false)
    })
  })
})
