import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisDel = vi.fn()
const redisSet = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    del: (...args: unknown[]) => redisDel(...args),
    set: (...args: unknown[]) => redisSet(...args),
  },
  RedisKeys: {
    session: (id: string) => `session:${id}`,
    deviceLinkedAccounts: (deviceId: string) => `device:${deviceId}:linked`,
  },
}))

const countLinkedAccounts = vi.fn()
const findLinkedAccounts = vi.fn()
const findActiveSessionAccountsOnDevice = vi.fn()
const upsertLinkedAccount = vi.fn()
const deleteLinkedAccount = vi.fn()
vi.mock('../../src/repositories/device.repository', () => ({
  deviceRepository: {
    countLinkedAccounts: (...args: unknown[]) => countLinkedAccounts(...args),
    findLinkedAccounts: (...args: unknown[]) => findLinkedAccounts(...args),
    findActiveSessionAccountsOnDevice: (...args: unknown[]) =>
      findActiveSessionAccountsOnDevice(...args),
    upsertLinkedAccount: (...args: unknown[]) => upsertLinkedAccount(...args),
    deleteLinkedAccount: (...args: unknown[]) => deleteLinkedAccount(...args),
  },
}))

const revokeByUserAndDevice = vi.fn()
vi.mock('../../src/repositories/session.repository', () => ({
  sessionRepository: {
    revokeByUserAndDevice: (...args: unknown[]) => revokeByUserAndDevice(...args),
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

const { deviceService } = await import('../../src/services/device.service')

const deviceId = 'dev-123'
const userId = 'user-1'

describe('deviceService linked accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('linkAccountToDevice', () => {
    it('links when under limit', async () => {
      countLinkedAccounts.mockResolvedValue(1)
      await deviceService.linkAccountToDevice(deviceId, userId)

      expect(upsertLinkedAccount).toHaveBeenCalledWith(deviceId, userId)
      expect(cacheDelete).toHaveBeenCalledWith(`device:${deviceId}:linked`)
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'DEVICE_ACCOUNT_LINKED',
          actionStatus: 'success',
          userId,
        }),
      )
    })

    it('throws when at limit and new user', async () => {
      countLinkedAccounts.mockResolvedValue(3)
      findLinkedAccounts.mockResolvedValue([
        { userId: 'u1' },
        { userId: 'u2' },
        { userId: 'u3' },
      ])

      await expect(
        deviceService.linkAccountToDevice(deviceId, userId),
      ).rejects.toMatchObject({
        code: 'DEVICE_ACCOUNT_LIMIT_REACHED',
        statusCode: 400,
      })
    })

    it('allows relink when already linked even at limit', async () => {
      countLinkedAccounts.mockResolvedValue(3)
      findLinkedAccounts.mockResolvedValue([
        { userId },
        { userId: 'u2' },
        { userId: 'u3' },
      ])

      await deviceService.linkAccountToDevice(deviceId, userId)

      expect(upsertLinkedAccount).toHaveBeenCalledWith(deviceId, userId)
    })
  })

  describe('unlinkAccountFromDevice', () => {
    it('throws when attempting to unlink active account', async () => {
      await expect(
        deviceService.unlinkAccountFromDevice(deviceId, userId, userId, { request: undefined }),
      ).rejects.toMatchObject({
        code: 'CANNOT_UNLINK_ACTIVE_ACCOUNT',
        statusCode: 400,
      })
    })

    it('deletes link, revokes sessions, busts cache and audits', async () => {
      revokeByUserAndDevice.mockResolvedValue(['s1', 's2'])

      await deviceService.unlinkAccountFromDevice(deviceId, 'target-user', userId, {
        request: { ip: '127.0.0.1', headers: {} },
      })

      expect(deleteLinkedAccount).toHaveBeenCalledWith(deviceId, 'target-user')
      expect(revokeByUserAndDevice).toHaveBeenCalledWith('target-user', deviceId)
      expect(redisDel).toHaveBeenCalledWith('session:s1')
      expect(redisDel).toHaveBeenCalledWith('session:s2')
      expect(cacheDelete).toHaveBeenCalledWith(`device:${deviceId}:linked`)
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'DEVICE_ACCOUNT_UNLINKED',
          actionStatus: 'success',
          actionDetails: { targetUserId: 'target-user', deviceId },
        }),
      )
    })
  })

  describe('getLinkedAccounts', () => {
    it('returns from cache when present', async () => {
      const cached = [{ userId: 'u1' }]
      cacheGet.mockResolvedValue(JSON.stringify(cached))

      const result = await deviceService.getLinkedAccounts(deviceId)

      expect(result).toEqual(cached)
      expect(findActiveSessionAccountsOnDevice).not.toHaveBeenCalled()
    })

    it('fetches active session accounts from repo and caches on miss', async () => {
      cacheGet.mockResolvedValue(null)
      const accounts = [
        {
          userId: 'u1',
          publicId: 123,
          displayName: 'User 1',
          avatarUrl: null,
          linkedAt: new Date(),
          lastUsedAt: new Date(),
        },
      ]
      findActiveSessionAccountsOnDevice.mockResolvedValue(accounts)

      const result = await deviceService.getLinkedAccounts(deviceId)

      expect(result).toHaveLength(1)
      expect(findActiveSessionAccountsOnDevice).toHaveBeenCalledWith(deviceId)
      expect(findLinkedAccounts).not.toHaveBeenCalled()
      expect(cacheSet).toHaveBeenCalledWith(
        `device:${deviceId}:linked`,
        expect.any(String),
        1800,
      )
    })
  })
})

