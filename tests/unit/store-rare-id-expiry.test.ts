import { describe, it, expect, vi, beforeEach } from 'vitest'
import { storeService } from '../../src/services/store.service'

const findUniqueAssignment = vi.fn()
const userVipAssignmentUpdate = vi.fn()
const userUpdateMany = vi.fn()
const vipPublicIdUpdate = vi.fn()

vi.mock('../../src/config/database', () => ({
  prisma: {
    userVipAssignment: {
      findUnique: (...a: unknown[]) => findUniqueAssignment(...a),
    },
    $transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        userVipAssignment: { update: userVipAssignmentUpdate },
        user: { updateMany: userUpdateMany },
        vipPublicId: { update: vipPublicIdUpdate },
      }
      await fn(tx as never)
    },
  },
  prismaRead: {},
}))

const redisDel = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: { del: (...a: unknown[]) => redisDel(...a) },
  RedisKeys: {
    userActiveVipId: (userId: string) => `user:active_vip:${userId}`,
    userActiveStore: (userId: string) => `user:active-store:${userId}`,
    userStoreItems: (userId: string) => `user:store:${userId}`,
    storeRareIds: () => 'store:rare-ids',
  },
  STORE_CATALOG_TTL: 1,
  STORE_ITEM_TTL: 1,
  STORE_RARE_IDS_TTL: 1,
  USER_ACTIVE_STORE_TTL: 1,
  USER_STORE_ITEMS_TTL: 1,
}))

const cacheDel = vi.fn()
const cacheDelByKeyPrefix = vi.fn()
vi.mock('../../src/services/cacheRedis.service', () => ({
  cacheRedisService: {
    del: (...a: unknown[]) => cacheDel(...a),
    delByKeyPrefix: (...a: unknown[]) => cacheDelByKeyPrefix(...a),
  },
}))

describe('storeService.processRareIdExpiryJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findUniqueAssignment.mockResolvedValue({
      id: 'asg1',
      userId: 'user-1',
      publicId: 40_000_000n,
      isActive: true,
    })
    userVipAssignmentUpdate.mockResolvedValue({})
    userUpdateMany.mockResolvedValue({ count: 1 })
    vipPublicIdUpdate.mockResolvedValue({})
  })

  it('deactivates assignment, resets vip_public_ids row, clears caches', async () => {
    await storeService.processRareIdExpiryJob('asg1')
    expect(userVipAssignmentUpdate).toHaveBeenCalledWith({
      where: { id: 'asg1' },
      data: { isActive: false },
    })
    expect(vipPublicIdUpdate).toHaveBeenCalledWith({
      where: { publicId: 40_000_000n },
      data: {
        isAvailable: true,
        currentOwnerId: null,
        expiresAt: null,
        purchasedAt: null,
        assignedAt: null,
      },
    })
    expect(redisDel).toHaveBeenCalled()
    expect(cacheDel).toHaveBeenCalled()
    expect(cacheDelByKeyPrefix).toHaveBeenCalledWith('user:store:user-1')
  })

  it('is idempotent when assignment already inactive', async () => {
    findUniqueAssignment.mockResolvedValue({
      id: 'asg1',
      userId: 'user-1',
      publicId: 40_000_000n,
      isActive: false,
    })
    await storeService.processRareIdExpiryJob('asg1')
    expect(userVipAssignmentUpdate).not.toHaveBeenCalled()
  })
})
