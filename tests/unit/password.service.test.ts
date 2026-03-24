import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/utils/bcrypt-async', () => ({
  hashAsync: vi.fn().mockResolvedValue('$2b$12$hashedpassword'),
  compareAsync: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../src/repositories/auth-password.repository', () => ({
  authPasswordRepository: {
    findByUserId: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
  },
}))

const { hashAsync, compareAsync } = await import('../../src/utils/bcrypt-async')
const { authPasswordRepository } = await import('../../src/repositories/auth-password.repository')
const { passwordService } = await import('../../src/services/password.service')

describe('passwordService', () => {
  beforeEach(() => {
    vi.mocked(hashAsync).mockClear()
    vi.mocked(compareAsync).mockClear()
    vi.mocked(authPasswordRepository.findByUserId).mockClear()
    vi.mocked(authPasswordRepository.update).mockClear()
  })

  describe('validateStrength', () => {
    it('returns ok for valid password', () => {
      const r = passwordService.validateStrength('ValidPass1!')
      expect(r.ok).toBe(true)
    })
    it('returns error for short password', () => {
      const r = passwordService.validateStrength('Short1!')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('8')
    })
    it('returns error when missing uppercase', () => {
      const r = passwordService.validateStrength('alllower1!')
      expect(r.ok).toBe(false)
    })
    it('returns error when missing special char', () => {
      const r = passwordService.validateStrength('NoSpecial1')
      expect(r.ok).toBe(false)
    })
  })

  describe('hash', () => {
    it('calls hashAsync and returns hash', async () => {
      vi.mocked(hashAsync).mockResolvedValue('$2b$12$xyz')
      const h = await passwordService.hash('mypass')
      expect(h).toBe('$2b$12$xyz')
      expect(hashAsync).toHaveBeenCalledWith('mypass')
    })
  })

  describe('compare', () => {
    it('calls compareAsync and returns result', async () => {
      vi.mocked(compareAsync).mockResolvedValue(true)
      const ok = await passwordService.compare('plain', '$2b$12$hash')
      expect(ok).toBe(true)
      expect(compareAsync).toHaveBeenCalledWith('plain', '$2b$12$hash')
    })
  })

  describe('hasPassword', () => {
    it('returns true when record exists', async () => {
      vi.mocked(authPasswordRepository.findByUserId).mockResolvedValue({ userId: 'u1', passwordHash: 'x' } as never)
      const ok = await passwordService.hasPassword('u1')
      expect(ok).toBe(true)
    })
    it('returns false when no record', async () => {
      vi.mocked(authPasswordRepository.findByUserId).mockResolvedValue(null)
      const ok = await passwordService.hasPassword('u1')
      expect(ok).toBe(false)
    })
  })
})
