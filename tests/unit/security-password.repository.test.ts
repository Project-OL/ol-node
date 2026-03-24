import { describe, it, expect, vi, beforeEach } from 'vitest'

const findUnique = vi.fn()
const upsert = vi.fn()
const update = vi.fn()
const deleteMock = vi.fn()

vi.mock('../../src/config/database', () => ({
  prisma: {
    securityPassword: {
      findUnique,
      upsert,
      update,
      delete: deleteMock,
    },
  },
  prismaRead: {
    securityPassword: {
      findUnique,
    },
  },
}))

const { securityPasswordRepository } = await import('../../src/repositories/security-password.repository')

describe('securityPasswordRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('findByUserId returns record when exists', async () => {
    const row = { id: '1', userId: 'u1', passwordHash: 'hash' }
    findUnique.mockResolvedValue(row)

    const result = await securityPasswordRepository.findByUserId('u1')

    expect(result).toEqual(row)
    expect(findUnique).toHaveBeenCalledWith({ where: { userId: 'u1' } })
  })

  it('findByUserId returns null when not found', async () => {
    findUnique.mockResolvedValue(null)

    const result = await securityPasswordRepository.findByUserId('u1')

    expect(result).toBeNull()
  })

  it('upsert creates or updates with correct data', async () => {
    upsert.mockResolvedValue({ userId: 'u1', passwordHash: 'h', setAt: new Date() })

    await securityPasswordRepository.upsert({
      userId: 'u1',
      passwordHash: 'hashed',
      failedAttempts: 0,
      lockedUntil: null,
    })

    expect(upsert).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      update: expect.objectContaining({
        passwordHash: 'hashed',
        failedAttempts: 0,
        lockedUntil: null,
      }),
      create: expect.objectContaining({
        userId: 'u1',
        passwordHash: 'hashed',
        failedAttempts: 0,
        lockedUntil: null,
      }),
    })
  })

  it('update patches record', async () => {
    update.mockResolvedValue({})

    await securityPasswordRepository.update('u1', {
      passwordHash: 'newHash',
      failedAttempts: 0,
      lockedUntil: null,
    })

    expect(update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { passwordHash: 'newHash', failedAttempts: 0, lockedUntil: null },
    })
  })

  it('resetFailedAttempts clears attempts and lock', async () => {
    update.mockResolvedValue(undefined)

    await securityPasswordRepository.resetFailedAttempts('u1')

    expect(update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { failedAttempts: 0, lockedUntil: null },
    })
  })

  it('delete removes record', async () => {
    deleteMock.mockResolvedValue(undefined)

    await securityPasswordRepository.delete('u1')

    expect(deleteMock).toHaveBeenCalledWith({ where: { userId: 'u1' } })
  })
})
