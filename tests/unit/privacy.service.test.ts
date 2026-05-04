import { describe, it, expect, vi, beforeEach } from 'vitest'

const cacheGet = vi.fn()
const cacheSet = vi.fn()
const cacheDelete = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {},
  getRedisForRead: () => ({ mget: vi.fn().mockResolvedValue([]) }),
  RedisKeys: {
    userPrivacySettings: (userId: string) => `user:${userId}:privacy:settings`,
    userPrivacyData: (userId: string) => `user:${userId}:privacy:data`,
    vipmActive: (userId: string) => `vipm:active:${userId}`,
  },
  VIPM_ACTIVE_INACTIVE_TTL: 300,
  VIPM_ACTIVE_TTL_MAX: 86400,
}))

vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    get: (...args: unknown[]) => cacheGet(...args),
    set: (...args: unknown[]) => cacheSet(...args),
    delete: (...args: unknown[]) => cacheDelete(...args),
  },
}))

const userFindById = vi.fn()
const userUpdate = vi.fn()
const findPrivacyFlagsBulk = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: (...args: unknown[]) => userFindById(...args),
    update: (...args: unknown[]) => userUpdate(...args),
    findPrivacyFlagsBulk: (...args: unknown[]) => findPrivacyFlagsBulk(...args),
  },
}))

const vipHasActive = vi.fn()
vi.mock('../../src/services/vip-membership.service', () => ({
  vipMembershipService: {
    hasActive: (...args: unknown[]) => vipHasActive(...args),
    hasActiveBulk: vi.fn().mockResolvedValue(new Map()),
  },
}))

const auditLog = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...args: unknown[]) => auditLog(...args) },
}))

const { privacyService } = await import('../../src/services/privacy.service')

const userId = 'user-123'

function makeUser(overrides: Partial<{
  id: string
  vipSubscriptionActive: boolean
  privacyInvisibleVisitor: boolean
  privacyMysteryLive: boolean
  privacyMysteryRank: boolean
  privacyInvisibleOnline: boolean
  privacyUpdatedAt: Date | null
  updatedAt: Date
}> = {}) {
  return {
    id: userId,
    vipSubscriptionActive: true,
    privacyInvisibleVisitor: false,
    privacyMysteryLive: false,
    privacyMysteryRank: false,
    privacyInvisibleOnline: false,
    privacyUpdatedAt: null,
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('PrivacyService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vipHasActive.mockResolvedValue(true)
    findPrivacyFlagsBulk.mockResolvedValue([])
  })

  describe('getSettings', () => {
    it('should return cached settings if available', async () => {
      const cached = {
        vipActive: true,
        settings: {
          invisibleVisitor: { enabled: true, description: 'x', effect: 'y' },
          mysteryLive: { enabled: false, description: 'a', effect: 'b' },
          mysteryRank: { enabled: false, description: 'c', effect: 'd' },
          invisibleOnline: { enabled: true, description: 'e', effect: 'f' },
        },
        updatedAt: new Date().toISOString(),
      }
      cacheGet.mockResolvedValue(JSON.stringify(cached))

      const result = await privacyService.getSettings(userId)

      expect(result.vipActive).toBe(true)
      expect(result.settings.invisibleVisitor.enabled).toBe(true)
      expect(userFindById).not.toHaveBeenCalled()
    })

    it('should fetch from DB if not cached', async () => {
      cacheGet.mockResolvedValue(null)
      const user = makeUser({
        privacyInvisibleVisitor: true,
        privacyMysteryLive: false,
        privacyMysteryRank: false,
        privacyInvisibleOnline: true,
        privacyUpdatedAt: new Date('2026-03-07T09:41:00Z'),
      })
      userFindById.mockResolvedValue(user)

      const result = await privacyService.getSettings(userId)

      expect(result.vipActive).toBe(true)
      expect(result.settings.invisibleVisitor.enabled).toBe(true)
      expect(result.settings.invisibleOnline.enabled).toBe(true)
      expect(cacheSet).toHaveBeenCalledWith(
        `user:${userId}:privacy:settings`,
        expect.any(String),
        3600,
      )
    })

    it('should return settings with vipActive false when paid VIP inactive', async () => {
      cacheGet.mockResolvedValue(null)
      userFindById.mockResolvedValue(makeUser({ vipSubscriptionActive: false }))
      vipHasActive.mockResolvedValueOnce(false)

      const result = await privacyService.getSettings(userId)

      expect(result.vipActive).toBe(false)
      expect(result.settings.invisibleVisitor.enabled).toBe(false)
    })

    it('should throw USER_NOT_FOUND if user missing', async () => {
      cacheGet.mockResolvedValue(null)
      userFindById.mockResolvedValue(null)

      await expect(privacyService.getSettings(userId)).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
        statusCode: 404,
      })
    })
  })

  describe('toggleInvisibleVisitor', () => {
    it('should toggle invisible visitor successfully and audit', async () => {
      userFindById.mockResolvedValue(makeUser({ vipSubscriptionActive: true }))
      userUpdate.mockResolvedValue({ privacyInvisibleVisitor: true, privacyUpdatedAt: new Date() })
      cacheDelete.mockResolvedValue(undefined)

      const result = await privacyService.toggleInvisibleVisitor(userId, true)

      expect(result.feature).toBe('invisibleVisitor')
      expect(result.enabled).toBe(true)
      expect(result.message).toBe('Invisible visitor enabled')
      expect(userUpdate).toHaveBeenCalledWith(userId, {
        privacyInvisibleVisitor: true,
        privacyUpdatedAt: expect.any(Date),
      })
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'PRIVACY_INVISIBLE_VISITOR_TOGGLED',
          actionStatus: 'success',
          userId,
          actionDetails: { enabled: true },
        }),
      )
      expect(cacheDelete).toHaveBeenCalledWith(`user:${userId}:privacy:settings`)
      expect(cacheDelete).toHaveBeenCalledWith(`user:${userId}:privacy:data`)
    })

    it('should allow toggle when paid VIP inactive (no write gate)', async () => {
      userFindById.mockResolvedValue(makeUser({ vipSubscriptionActive: false }))
      userUpdate.mockResolvedValue({ privacyInvisibleVisitor: true, privacyUpdatedAt: new Date() })
      cacheDelete.mockResolvedValue(undefined)

      const result = await privacyService.toggleInvisibleVisitor(userId, true)

      expect(result.enabled).toBe(true)
      expect(userUpdate).toHaveBeenCalled()
    })

    it('should return disabled message when enabling false', async () => {
      userFindById.mockResolvedValue(makeUser({ vipSubscriptionActive: true }))
      userUpdate.mockResolvedValue({})

      const result = await privacyService.toggleInvisibleVisitor(userId, false)

      expect(result.enabled).toBe(false)
      expect(result.message).toBe('Invisible visitor disabled')
    })
  })

  describe('toggleMysteryLive', () => {
    it('should toggle mystery live successfully', async () => {
      userFindById.mockResolvedValue(makeUser({ vipSubscriptionActive: true }))
      userUpdate.mockResolvedValue({ privacyMysteryLive: true, privacyUpdatedAt: new Date() })
      cacheDelete.mockResolvedValue(undefined)

      const result = await privacyService.toggleMysteryLive(userId, true)

      expect(result.feature).toBe('mysteryLive')
      expect(result.enabled).toBe(true)
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'PRIVACY_MYSTERY_LIVE_TOGGLED' }),
      )
    })

    it('should toggle when paid VIP inactive (no write gate)', async () => {
      userFindById.mockResolvedValue(makeUser({ vipSubscriptionActive: false }))
      userUpdate.mockResolvedValue({ privacyMysteryLive: true, privacyUpdatedAt: new Date() })
      cacheDelete.mockResolvedValue(undefined)

      const result = await privacyService.toggleMysteryLive(userId, true)
      expect(result.enabled).toBe(true)
    })
  })

  describe('toggleMysteryRank', () => {
    it('should toggle mystery rank successfully', async () => {
      userFindById.mockResolvedValue(makeUser({ vipSubscriptionActive: true }))
      userUpdate.mockResolvedValue({ privacyMysteryRank: true, privacyUpdatedAt: new Date() })
      cacheDelete.mockResolvedValue(undefined)

      const result = await privacyService.toggleMysteryRank(userId, true)

      expect(result.feature).toBe('mysteryRank')
      expect(result.enabled).toBe(true)
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'PRIVACY_MYSTERY_RANK_TOGGLED' }),
      )
    })
  })

  describe('toggleInvisibleOnline', () => {
    it('should toggle invisible online and include auto-disable message when enabled', async () => {
      userFindById.mockResolvedValue(makeUser({ vipSubscriptionActive: true }))
      userUpdate.mockResolvedValue({ privacyInvisibleOnline: true, privacyUpdatedAt: new Date() })
      cacheDelete.mockResolvedValue(undefined)

      const result = await privacyService.toggleInvisibleOnline(userId, true)

      expect(result.feature).toBe('invisibleOnline')
      expect(result.enabled).toBe(true)
      expect(result.message).toContain('auto-disable')
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'PRIVACY_INVISIBLE_ONLINE_TOGGLED' }),
      )
    })

    it('should return disabled message when disabling', async () => {
      userFindById.mockResolvedValue(makeUser({ vipSubscriptionActive: true }))
      userUpdate.mockResolvedValue({})

      const result = await privacyService.toggleInvisibleOnline(userId, false)

      expect(result.message).toBe('Invisible online disabled')
    })
  })

  describe('getUserPrivacySettings', () => {
    it('should return user privacy settings from cache', async () => {
      const cached = {
        invisibleVisitor: true,
        mysteryLive: false,
        mysteryRank: false,
        invisibleOnline: true,
      }
      cacheGet.mockResolvedValue(JSON.stringify(cached))

      const result = await privacyService.getUserPrivacySettings(userId)

      expect(result.invisibleVisitor).toBe(true)
      expect(result.invisibleOnline).toBe(true)
      expect(userFindById).not.toHaveBeenCalled()
    })

    it('should fetch from DB if not cached and then cache', async () => {
      cacheGet.mockResolvedValue(null)
      const user = makeUser({
        privacyInvisibleVisitor: true,
        privacyMysteryRank: true,
        privacyInvisibleOnline: false,
      })
      userFindById.mockResolvedValue(user)

      const result = await privacyService.getUserPrivacySettings(userId)

      expect(result.invisibleVisitor).toBe(true)
      expect(result.mysteryRank).toBe(true)
      expect(result.invisibleOnline).toBe(false)
      expect(cacheSet).toHaveBeenCalledWith(
        `user:${userId}:privacy:data`,
        expect.any(String),
        3600,
      )
    })

    it('should throw USER_NOT_FOUND if user missing', async () => {
      cacheGet.mockResolvedValue(null)
      userFindById.mockResolvedValue(null)

      await expect(privacyService.getUserPrivacySettings(userId)).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
        statusCode: 404,
      })
    })
  })

  describe('toggle error handling', () => {
    it('should throw USER_NOT_FOUND when user missing on toggle', async () => {
      userFindById.mockResolvedValue(null)

      await expect(
        privacyService.toggleInvisibleVisitor(userId, true),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' })
    })
  })
})
