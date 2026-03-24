import { describe, it, expect, vi, beforeEach } from 'vitest'

const sessionFindMany = vi.fn()
const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 0 })

vi.mock('../../src/config/database', () => ({
  prisma: {
    session: {
      findMany: sessionFindMany,
      updateMany: sessionUpdateMany,
    },
  },
  prismaRead: {
    session: {
      findMany: sessionFindMany,
    },
  },
}))

const { prisma } = await import('../../src/config/database')
const { sessionRepository } = await import('../../src/repositories/session.repository')

describe('sessionRepository.deleteOldestSessionsIfOverLimit', () => {
  beforeEach(() => {
    sessionFindMany.mockClear()
    sessionUpdateMany.mockClear()
  })

  it('does nothing when session count <= 3', async () => {
    sessionFindMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }])
    await sessionRepository.deleteOldestSessionsIfOverLimit('user-1')
    expect(sessionUpdateMany).not.toHaveBeenCalled()
  })

  it('calls updateMany once with ids to revoke when over limit', async () => {
    sessionFindMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }])
    await sessionRepository.deleteOldestSessionsIfOverLimit('user-1')
    expect(sessionUpdateMany).toHaveBeenCalledTimes(1)
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] } },
      data: { isActive: false, isRevoked: true, revokedAt: expect.any(Date) },
    })
  })
})
