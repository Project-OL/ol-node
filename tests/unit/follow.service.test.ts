import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisDel = vi.fn()
const redisGet = vi.fn()
const redisSet = vi.fn()

vi.mock('../../src/config/redis', () => ({
  RedisKeys: {
    socialCounts: (userId: string) => `social:counts:${userId}`,
  },
  redisClient: {
    get: (...args: unknown[]) => redisGet(...args),
    set: (...args: unknown[]) => redisSet(...args),
    del: (...args: unknown[]) => redisDel(...args),
  },
}))

const cacheGet = vi.fn()
const cacheSet = vi.fn()
const cacheDelete = vi.fn()
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    get: (...args: unknown[]) => cacheGet(...args),
    set: (...args: unknown[]) => cacheSet(...args),
    delete: (...args: unknown[]) => cacheDelete(...args),
  },
}))

const auditLog = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...args: unknown[]) => auditLog(...args) },
}))

const upsertFollow = vi.fn()
const deleteFollow = vi.fn()
const existsFollow = vi.fn()
const countFollowers = vi.fn()
const countFollowing = vi.fn()
const countFriends = vi.fn()
const findFollowers = vi.fn()
vi.mock('../../src/repositories/follow.repository', () => ({
  followRepository: {
    upsertFollow: (...args: unknown[]) => upsertFollow(...args),
    deleteFollow: (...args: unknown[]) => deleteFollow(...args),
    existsFollow: (...args: unknown[]) => existsFollow(...args),
    countFollowers: (...args: unknown[]) => countFollowers(...args),
    countFollowing: (...args: unknown[]) => countFollowing(...args),
    countFriends: (...args: unknown[]) => countFriends(...args),
    findFollowers: (...args: unknown[]) => findFollowers(...args),
    findFollowing: vi.fn(),
    findFriends: vi.fn(),
  },
}))

const getDisplayLevelsForUsers = vi.fn()
vi.mock('../../src/services/user-level.service', () => ({
  walletLevelService: {
    getDisplayLevelsForUsers: (...args: unknown[]) =>
      getDisplayLevelsForUsers(...args),
  },
}))

const countSubscribersForCreators = vi.fn()
vi.mock('../../src/repositories/userSubscriber.repository', () => ({
  userSubscriberRepository: {
    countSubscribersForCreators: (...args: unknown[]) =>
      countSubscribersForCreators(...args),
  },
}))

const isSuperHost = vi.fn()
vi.mock('../../src/services/super-host.service', () => ({
  superHostService: {
    isSuperHost: (...args: unknown[]) => isSuperHost(...args),
  },
}))

const getActiveGuardianSummary = vi.fn()
vi.mock('../../src/services/guardian.service', () => ({
  guardianService: {
    getActiveGuardianSummary: (...args: unknown[]) => getActiveGuardianSummary(...args),
  },
}))

const { followService } = await import('../../src/services/follow.service')

describe('followService', () => {
  const followerId = 'user-1'
  const targetUserId = 'user-2'

  beforeEach(() => {
    vi.clearAllMocks()
    isSuperHost.mockResolvedValue(false)
    getActiveGuardianSummary.mockResolvedValue(null)
  })

  it('throws CANNOT_FOLLOW_SELF when followerId === targetUserId', async () => {
    await expect(
      followService.follow(followerId, followerId, {}),
    ).rejects.toMatchObject({
      code: 'CANNOT_FOLLOW_SELF',
      statusCode: 400,
    })
  })

  it('throws ALREADY_FOLLOWING when follow already exists', async () => {
    existsFollow.mockResolvedValueOnce(true)

    await expect(
      followService.follow(followerId, targetUserId, {}),
    ).rejects.toMatchObject({
      code: 'ALREADY_FOLLOWING',
      statusCode: 409,
    })
  })

  it('follows user, busts cache, and derives isFriend correctly', async () => {
    existsFollow
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true) // second call: target follows follower
    upsertFollow.mockResolvedValueOnce(undefined)

    const result = await followService.follow(followerId, targetUserId, {
      request: { ip: '127.0.0.1', headers: {} },
      deviceId: 'dev-1',
    })

    expect(upsertFollow).toHaveBeenCalledWith(followerId, targetUserId)
    expect(cacheDelete).toHaveBeenCalledWith('social:counts:user-1')
    expect(cacheDelete).toHaveBeenCalledWith('social:counts:user-2')
    expect(result.following).toBe(true)
    expect(result.isFriend).toBe(true)
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'USER_FOLLOWED',
        actionStatus: 'success',
        actionDetails: { targetUserId, isFriend: true },
      }),
    )
  })

  it('unfollow propagates NOT_FOLLOWING and busts cache', async () => {
    deleteFollow.mockRejectedValueOnce(
      Object.assign(new Error('not following'), {
        statusCode: 404,
        code: 'NOT_FOLLOWING',
      }),
    )

    await expect(
      followService.unfollow(followerId, targetUserId, {}),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOLLOWING',
    })
  })

  it('getCounts uses cache when available', async () => {
    cacheGet.mockResolvedValueOnce(
      JSON.stringify({ followers: 1, following: 2, friends: 3 }),
    )

    const result = await followService.getCounts(followerId)

    expect(result.followers).toBe(1)
    expect(countFollowers).not.toHaveBeenCalled()
  })

  it('getCounts computes and caches when miss', async () => {
    cacheGet.mockResolvedValueOnce(null)
    countFollowers.mockResolvedValueOnce(5)
    countFollowing.mockResolvedValueOnce(10)
    countFriends.mockResolvedValueOnce(2)

    const result = await followService.getCounts(followerId)

    expect(result.followers).toBe(5)
    expect(result.following).toBe(10)
    expect(result.friends).toBe(2)
    expect(cacheSet).toHaveBeenCalledWith(
      'social:counts:user-1',
      JSON.stringify({ followers: 5, following: 10, friends: 2 }),
      300,
    )
  })
})

