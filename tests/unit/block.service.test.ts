import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../src/middlewares/errorHandler'

const findByPublicId = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findByPublicId: (...args: unknown[]) => findByPublicId(...args),
  },
}))

const findBlock = vi.fn()
const blockUser = vi.fn()
vi.mock('../../src/repositories/block.repository', () => ({
  blockRepository: {
    findBlock: (...args: unknown[]) => findBlock(...args),
    blockUser: (...args: unknown[]) => blockUser(...args),
  },
}))

const deleteFollowsBetween = vi.fn()
vi.mock('../../src/repositories/follow.repository', () => ({
  followRepository: {
    deleteFollowsBetween: (...args: unknown[]) => deleteFollowsBetween(...args),
  },
}))

const invalidateSocialCountsCache = vi.fn()
vi.mock('../../src/services/follow.service', () => ({
  invalidateSocialCountsCache: (...args: unknown[]) => invalidateSocialCountsCache(...args),
}))

const cacheDelete = vi.fn()
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    delete: (...args: unknown[]) => cacheDelete(...args),
    get: vi.fn(),
    set: vi.fn(),
  },
}))

const redisDel = vi.fn().mockResolvedValue(1)
vi.mock('../../src/config/redis', () => {
  const stubRedis = {
    on: vi.fn(),
    once: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    del: (...args: unknown[]) => redisDel(...args),
  }
  return {
    redisClient: stubRedis,
    redisReadClient: null,
    getRedisForRead: () => stubRedis,
    BLOCK_LIST_TTL: 3600,
    RedisKeys: {
      blockList: (userId: string) => `blocklist:v2:${userId}`,
      allowedMessaging: (recipientId: string, senderId: string) =>
        `allowed-messaging:${recipientId}:${senderId}`,
      socialCounts: (userId: string) => `social:counts:${userId}`,
    },
  }
})

const stopRenewalsDueToBlock = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/subscription.service', () => ({
  subscriptionService: {
    stopRenewalsDueToBlock: (...args: unknown[]) => stopRenewalsDueToBlock(...args),
  },
}))

const auditLog = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...args: unknown[]) => auditLog(...args) },
}))

const { blockService } = await import('../../src/services/block.service')

const blockerId = 'blocker-uuid'
const blockedId = 'blocked-uuid'
const blockedPublicId = '100042'

beforeEach(() => {
  vi.clearAllMocks()
  redisDel.mockResolvedValue(1)
  deleteFollowsBetween.mockResolvedValue(2)
  blockUser.mockResolvedValue(undefined)
  invalidateSocialCountsCache.mockResolvedValue(undefined)
  cacheDelete.mockResolvedValue(undefined)
  stopRenewalsDueToBlock.mockResolvedValue(undefined)
  auditLog.mockResolvedValue(undefined)
})

describe('blockService.blockUser', () => {
  it('creates block then deletes follow edges both ways and busts social caches', async () => {
    findByPublicId.mockResolvedValue({ id: blockedId, publicId: BigInt(blockedPublicId) })
    findBlock.mockResolvedValue(null)

    await blockService.blockUser(blockerId, blockedPublicId)

    expect(blockUser).toHaveBeenCalledWith(blockerId, blockedId)
    expect(deleteFollowsBetween).toHaveBeenCalledTimes(1)
    expect(deleteFollowsBetween).toHaveBeenCalledWith(blockerId, blockedId)
    expect(deleteFollowsBetween.mock.invocationCallOrder[0]).toBeGreaterThan(
      blockUser.mock.invocationCallOrder[0]!,
    )
    expect(cacheDelete).toHaveBeenCalledWith(`blocklist:v2:${blockerId}`)
    expect(invalidateSocialCountsCache).toHaveBeenCalledWith(blockerId, blockedId)
    expect(stopRenewalsDueToBlock).toHaveBeenCalledWith(blockerId, blockedId)
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'BLOCK_USER',
        actionStatus: 'success',
        userId: blockerId,
      }),
    )
  })

  it('does not delete follows when blocking yourself', async () => {
    findByPublicId.mockResolvedValue({ id: blockerId, publicId: BigInt(blockedPublicId) })

    await expect(blockService.blockUser(blockerId, blockedPublicId)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_REQUEST',
    })

    expect(blockUser).not.toHaveBeenCalled()
    expect(deleteFollowsBetween).not.toHaveBeenCalled()
    expect(invalidateSocialCountsCache).not.toHaveBeenCalled()
  })

  it('does not delete follows when already blocked', async () => {
    findByPublicId.mockResolvedValue({ id: blockedId, publicId: BigInt(blockedPublicId) })
    findBlock.mockResolvedValue({ id: 'existing-block' })

    await expect(blockService.blockUser(blockerId, blockedPublicId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ALREADY_BLOCKED',
    })

    expect(blockUser).not.toHaveBeenCalled()
    expect(deleteFollowsBetween).not.toHaveBeenCalled()
    expect(invalidateSocialCountsCache).not.toHaveBeenCalled()
  })

  it('throws NOT_FOUND when publicId does not resolve', async () => {
    findByPublicId.mockResolvedValue(null)

    await expect(blockService.blockUser(blockerId, blockedPublicId)).rejects.toBeInstanceOf(AppError)
    await expect(blockService.blockUser(blockerId, blockedPublicId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    })

    expect(deleteFollowsBetween).not.toHaveBeenCalled()
  })
})
