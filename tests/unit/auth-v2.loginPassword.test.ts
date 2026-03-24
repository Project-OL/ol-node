import { describe, it, expect, vi, beforeEach } from 'vitest'

const passwordCompare = vi.fn().mockResolvedValue(true)
const passwordHasPassword = vi.fn()
vi.mock('../../src/services/password.service', () => ({
  passwordService: {
    compare: (...args: unknown[]) => passwordCompare(...args),
    hasPassword: (...args: unknown[]) => passwordHasPassword(...args),
  },
}))
vi.mock('../../src/services/session.service', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      sessionId: 'sid',
      expiresIn: 900,
    }),
  },
}))

const countLinkedAccounts = vi.fn().mockResolvedValue(0)
const findLinkedAccounts = vi.fn().mockResolvedValue([])
const upsertLinkedAccount = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/repositories/device.repository', () => ({
  deviceRepository: {
    countLinkedAccounts: (...args: unknown[]) => countLinkedAccounts(...args),
    findLinkedAccounts: (...args: unknown[]) => findLinkedAccounts(...args),
    upsertLinkedAccount: (...args: unknown[]) => upsertLinkedAccount(...args),
  },
}))
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findByPublicId: vi.fn(),
  },
}))
const findByProviderAndIdentifier = vi.fn()
vi.mock('../../src/repositories/auth-identifier.repository', () => ({
  authIdentifierRepository: {
    findByProviderAndIdentifier: (...args: unknown[]) => findByProviderAndIdentifier(...args),
  },
}))

const prismaMock = {
  authPassword: {
    findUnique: vi.fn(),
  },
}
vi.mock('../../src/config/database', () => ({
  prisma: prismaMock,
  prismaRead: {},
}))

const { authV2Service } = await import('../../src/services/auth-v2.service')

describe('authV2Service.loginPassword', () => {
  beforeEach(() => {
    prismaMock.authPassword.findUnique.mockClear()
    passwordCompare.mockClear()
    passwordHasPassword.mockClear()
    findByProviderAndIdentifier.mockClear()
  })

  it('uses single findUnique with include user (no separate hasPassword call)', async () => {
    const user = {
      id: 'u1',
      publicId: BigInt(123),
      passwordSet: true,
      status: 'active',
    }
    prismaMock.authPassword.findUnique.mockResolvedValue({
      userId: 'u1',
      passwordHash: '$2b$12$hash',
      user,
    } as never)
    findByProviderAndIdentifier.mockResolvedValue({
      userId: 'u1',
      user,
    })

    const result = await authV2Service.loginPassword(
      'email',
      'user@example.com',
      'ValidPass1!',
      'Device',
      'dev-1',
    )

    expect(prismaMock.authPassword.findUnique).toHaveBeenCalledTimes(1)
    expect(prismaMock.authPassword.findUnique).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      include: { user: { select: { id: true, publicId: true, passwordSet: true, status: true } } },
    })
    expect(passwordHasPassword).not.toHaveBeenCalled()
    expect(result.userId).toBe('u1')
    expect(result.accessToken).toBe('at')
  })
})
