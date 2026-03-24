import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisGet = vi.fn()
const redisSet = vi.fn()

vi.mock('../../src/config/redis', () => ({
  RedisKeys: {
    visitorCooldown: (profileId: string, visitorId: string) =>
      `visitor:cooldown:${profileId}:${visitorId}`,
  },
  redisClient: {
    get: (...args: unknown[]) => redisGet(...args),
    set: (...args: unknown[]) => redisSet(...args),
  },
}))

const cacheGet = vi.fn()
const cacheSet = vi.fn()
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    get: (...args: unknown[]) => cacheGet(...args),
    set: (...args: unknown[]) => cacheSet(...args),
  },
}))

const auditLog = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...args: unknown[]) => auditLog(...args) },
}))

const findById = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: (...args: unknown[]) => findById(...args),
  },
}))

const upsertVisitor = vi.fn()
const trimVisitors = vi.fn()
const findVisitors = vi.fn()
vi.mock('../../src/repositories/visitor.repository', () => ({
  visitorRepository: {
    upsertVisitor: (...args: unknown[]) => upsertVisitor(...args),
    trimVisitors: (...args: unknown[]) => trimVisitors(...args),
    findVisitors: (...args: unknown[]) => findVisitors(...args),
    findVisitHistory: vi.fn(),
  },
}))

const getLevelForUsers = vi.fn()
vi.mock('../../src/services/userLevel.service', () => ({
  userLevelService: {
    getLevelForUsers: (...args: unknown[]) => getLevelForUsers(...args),
  },
}))

const countSubscribersForCreators = vi.fn()
vi.mock('../../src/repositories/userSubscriber.repository', () => ({
  userSubscriberRepository: {
    countSubscribersForCreators: (...args: unknown[]) =>
      countSubscribersForCreators(...args),
  },
}))

const { visitorService } = await import('../../src/services/visitor.service')

describe('visitorService', () => {
  const profileId = 'profile-1'
  const visitorId = 'visitor-1'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns silently when visiting own profile', async () => {
    await visitorService.recordVisit(profileId, profileId, {})
    expect(findById).not.toHaveBeenCalled()
  })

  it('returns silently when invisibleVisitor is true', async () => {
    findById.mockResolvedValueOnce({ id: visitorId, privacyInvisibleVisitor: true })

    await visitorService.recordVisit(profileId, visitorId, {})

    expect(upsertVisitor).not.toHaveBeenCalled()
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('returns silently when cooldown active', async () => {
    findById.mockResolvedValueOnce({ id: visitorId, privacyInvisibleVisitor: false })
    redisGet.mockResolvedValueOnce('1')

    await visitorService.recordVisit(profileId, visitorId, {})

    expect(upsertVisitor).not.toHaveBeenCalled()
  })

  it('creates new visit, trims visitors, sets cooldown, and audits', async () => {
    findById.mockResolvedValueOnce({ id: visitorId, privacyInvisibleVisitor: false })
    redisGet.mockResolvedValueOnce(null)
    upsertVisitor.mockResolvedValueOnce({ isNew: true })

    await visitorService.recordVisit(profileId, visitorId, {
      request: { ip: '127.0.0.1', headers: {} },
      deviceId: 'dev-1',
    })

    expect(upsertVisitor).toHaveBeenCalledWith(profileId, visitorId)
    expect(trimVisitors).toHaveBeenCalledWith(profileId)
    expect(redisSet).toHaveBeenCalledWith(
      `visitor:cooldown:${profileId}:${visitorId}`,
      '1',
      'EX',
      300,
    )
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'PROFILE_VISITED',
        actionStatus: 'success',
      }),
    )
  })
})

