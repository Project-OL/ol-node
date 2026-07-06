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
  invalidateUserTokenVersionCache: vi.fn(),
}))
vi.mock('../../src/services/device.service', () => ({
  deviceService: {
    linkAccountToDevice: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    delete: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    set: vi.fn(),
  },
}))
const findByPublicId = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findByPublicId: (...args: unknown[]) => findByPublicId(...args),
  },
}))
const findForLoginWithPassword = vi.fn()
const findByProviderAndIdentifier = vi.fn()
vi.mock('../../src/repositories/auth-identifier.repository', () => ({
  authIdentifierRepository: {
    findForLoginWithPassword: (...args: unknown[]) => findForLoginWithPassword(...args),
    findByProviderAndIdentifier: (...args: unknown[]) => findByProviderAndIdentifier(...args),
  },
}))

const prismaMock = {
  authPassword: {
    findUnique: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
}
vi.mock('../../src/config/database', () => ({
  prisma: prismaMock,
  prismaRead: {},
}))

const { authV2Service } = await import('../../src/services/auth-v2.service')

function fullUser(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u1',
    publicId: BigInt(123),
    passwordSet: true,
    status: 'active',
    suspendedUntil: null,
    firstName: 'Test',
    lastName: 'User',
    username: 'testuser',
    avatarUrl: null,
    isSupport: false,
    authPassword: { userId: 'u1', passwordHash: '$2b$12$hash' },
    ...over,
  }
}

describe('authV2Service.loginPassword', () => {
  beforeEach(() => {
    prismaMock.authPassword.findUnique.mockReset()
    prismaMock.user.findUnique.mockReset()
    passwordCompare.mockReset()
    passwordCompare.mockResolvedValue(true)
    passwordHasPassword.mockReset()
    findForLoginWithPassword.mockReset()
    findByProviderAndIdentifier.mockReset()
    findByPublicId.mockReset()
  })

  it('email path resolves credential + user + hash in one lookup (no extra queries)', async () => {
    findForLoginWithPassword.mockResolvedValue({
      userId: 'u1',
      user: fullUser(),
    })

    const result = await authV2Service.loginPassword(
      'email',
      'user@example.com',
      'ValidPass1!',
      'Device',
      'dev-1',
    )

    expect(findForLoginWithPassword).toHaveBeenCalledWith('email', 'user@example.com')
    // Collapsed round-trips: no standalone authPassword or profile queries anymore.
    expect(prismaMock.authPassword.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
    expect(passwordHasPassword).not.toHaveBeenCalled()
    expect(passwordCompare).toHaveBeenCalledWith('ValidPass1!', '$2b$12$hash')
    expect(result.userId).toBe('u1')
    expect(result.publicId).toBe(123)
    expect(result.accessToken).toBe('at')
    expect(result.sessionId).toBe('sid')
  })

  it('email path returns PASSWORD_NOT_SET when user has no password row', async () => {
    findForLoginWithPassword.mockResolvedValue({
      userId: 'u1',
      user: fullUser({ authPassword: null }),
    })

    await expect(
      authV2Service.loginPassword('email', 'user@example.com', 'x', 'Device', 'dev-1'),
    ).rejects.toMatchObject({ statusCode: 401, code: 'PASSWORD_NOT_SET' })
    expect(passwordCompare).not.toHaveBeenCalled()
  })

  it('email path returns INVALID_CREDENTIALS on password mismatch', async () => {
    findForLoginWithPassword.mockResolvedValue({
      userId: 'u1',
      user: fullUser(),
    })
    passwordCompare.mockResolvedValue(false)

    await expect(
      authV2Service.loginPassword('email', 'user@example.com', 'wrong', 'Device', 'dev-1'),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' })
  })

  it('publicId path re-reads the hash from the primary (no include)', async () => {
    findByPublicId.mockResolvedValue(fullUser())
    prismaMock.authPassword.findUnique.mockResolvedValue({
      userId: 'u1',
      passwordHash: '$2b$12$primary',
    } as never)

    const result = await authV2Service.loginPassword(
      'publicId',
      '123',
      'ValidPass1!',
      'Device',
      'dev-1',
    )

    expect(findForLoginWithPassword).not.toHaveBeenCalled()
    expect(prismaMock.authPassword.findUnique).toHaveBeenCalledTimes(1)
    expect(prismaMock.authPassword.findUnique).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    })
    expect(passwordCompare).toHaveBeenCalledWith('ValidPass1!', '$2b$12$primary')
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
    expect(result.userId).toBe('u1')
  })
})
