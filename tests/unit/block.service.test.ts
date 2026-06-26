import { describe, it, expect, vi, beforeEach } from 'vitest'

const blockUser = vi.fn()
const findBlock = vi.fn()
vi.mock('../../src/repositories/block.repository', () => ({
  blockRepository: {
    blockUser: (...args: unknown[]) => blockUser(...args),
    findBlock: (...args: unknown[]) => findBlock(...args),
  },
}))

const findByPublicId = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findByPublicId: (...args: unknown[]) => findByPublicId(...args),
  },
}))

const cacheDelete = vi.fn()
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    delete: (...args: unknown[]) => cacheDelete(...args),
  },
}))

const auditLog = vi.fn()
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...args: unknown[]) => auditLog(...args) },
}))

const stopRenewalsDueToBlock = vi.fn()
vi.mock('../../src/services/subscription.service', () => ({
  subscriptionService: {
    stopRenewalsDueToBlock: (...args: unknown[]) => stopRenewalsDueToBlock(...args),
  },
}))

const invalidateSocialCountsCache = vi.fn()
vi.mock('../../src/services/follow.service', () => ({
  invalidateSocialCountsCache: (...args: unknown[]) => invalidateSocialCountsCache(...args),
}))

const deleteFollowsBetween = vi.fn()
vi.mock('../../src/repositories/follow.repository', () => ({
  followRepository: {
    deleteFollowsBetween: (...args: unknown[]) => deleteFollowsBetween(...args),
  },
}))

vi.mock('../../src/config/redis', () => ({
  RedisKeys: {
    blockList: (id: string) => `blocklist:${id}`,
    allowedMessaging: (a: string, b: string) => `allowed-messaging:${a}:${b}`,
  },
  BLOCK_LIST_TTL: 300,
  redisClient: { del: vi.fn().mockResolvedValue(1) },
}))

import { blockService } from '../../src/services/block.service'

describe('blockService.blockUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findByPublicId.mockResolvedValue({ id: 'user-b', publicId: 100042n })
    findBlock.mockResolvedValue(null)
    blockUser.mockResolvedValue({ id: 'block-1' })
    deleteFollowsBetween.mockResolvedValue(1)
  })

  it('removes follow relationships in both directions when blocking', async () => {
    await blockService.blockUser('user-a', '100042')

    expect(blockUser).toHaveBeenCalledWith('user-a', 'user-b')
    expect(deleteFollowsBetween).toHaveBeenCalledWith('user-a', 'user-b')
    expect(invalidateSocialCountsCache).toHaveBeenCalledWith('user-a', 'user-b')
  })
})
