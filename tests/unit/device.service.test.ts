import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisGet = vi.fn()
const redisDel = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    get: (...args: unknown[]) => redisGet(...args),
    del: (...args: unknown[]) => redisDel(...args),
  },
  RedisKeys: {
    userDevices: (userId: string) => `user:${userId}:devices`,
    userSessions: (userId: string) => `user:${userId}:sessions`,
    session: (id: string) => `session:${id}`,
  },
}))

const deviceFindById = vi.fn()
const deviceFindByUserId = vi.fn()
const deviceUpdate = vi.fn()
vi.mock('../../src/repositories/device.repository', () => ({
  deviceRepository: {
    findById: (...args: unknown[]) => deviceFindById(...args),
    findByUserId: (...args: unknown[]) => deviceFindByUserId(...args),
    update: (...args: unknown[]) => deviceUpdate(...args),
  },
}))

const sessionFindActiveByUserId = vi.fn()
const sessionFindActiveByUserIdAndDeviceId = vi.fn()
const sessionRevokeById = vi.fn()
const sessionCountActiveByUserId = vi.fn()
vi.mock('../../src/repositories/session.repository', () => ({
  sessionRepository: {
    findActiveByUserId: (...args: unknown[]) => sessionFindActiveByUserId(...args),
    findActiveByUserIdAndDeviceId: (...args: unknown[]) =>
      sessionFindActiveByUserIdAndDeviceId(...args),
    revokeById: (...args: unknown[]) => sessionRevokeById(...args),
    countActiveByUserId: (...args: unknown[]) => sessionCountActiveByUserId(...args),
  },
}))

const secFindByUserId = vi.fn()
vi.mock('../../src/repositories/security-password.repository', () => ({
  securityPasswordRepository: {
    findByUserId: (...args: unknown[]) => secFindByUserId(...args),
  },
}))

const cacheGetUserDevices = vi.fn()
const cacheSetUserDevices = vi.fn()
const cacheInvalidateUserDevicesAndSessions = vi.fn()
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    getUserDevices: (...args: unknown[]) => cacheGetUserDevices(...args),
    setUserDevices: (...args: unknown[]) => cacheSetUserDevices(...args),
    invalidateUserDevicesAndSessions: (...args: unknown[]) =>
      cacheInvalidateUserDevicesAndSessions(...args),
  },
}))

const passwordCompare = vi.fn()
vi.mock('../../src/services/password.service', () => ({
  passwordService: {
    compare: (...args: unknown[]) => passwordCompare(...args),
  },
}))

const auditLog = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...args: unknown[]) => auditLog(...args) },
}))

const { deviceService } = await import('../../src/services/device.service')

const userId = 'user-123'
const currentDeviceId = 'hw-device-1'
const registryId1 = 'reg-uuid-1'
const registryId2 = 'reg-uuid-2'

function makeDevice(overrides: Partial<{
  id: string
  deviceId: string
  deviceName: string
  platform: string
  lastActiveAt: Date
  loginAt: Date
  ipAddress: string | null
  userAgent: string | null
}> = {}) {
  return {
    id: registryId1,
    userId,
    deviceId: currentDeviceId,
    deviceName: 'iPhone',
    platform: 'ios',
    lastActiveAt: new Date(),
    loginAt: new Date(),
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0',
    ...overrides,
  }
}

function makeSession(
  overrides: Partial<{
    id: string
    deviceId: string
    deviceName: string
    lastActiveAt: Date
    expiresAt: Date
  }> = {},
) {
  const future = new Date(Date.now() + 86400000)
  return {
    id: 'sess-1',
    deviceId: currentDeviceId,
    deviceName: 'iPhone',
    lastActiveAt: new Date(),
    expiresAt: future,
    ...overrides,
  }
}

describe('DeviceService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getDevices', () => {
    it('returns parsed list from cache when cache hit', async () => {
      const cached = [
        {
          id: registryId1,
          deviceId: 'dev-1',
          deviceName: 'iPhone',
          platform: 'ios',
          isCurrentDevice: true,
          lastActiveAt: new Date().toISOString(),
          lastActiveTimeAgo: 'just now',
          loginAt: new Date().toISOString(),
          ipAddress: null,
          userAgent: null,
          sessionId: 's1',
        },
      ]
      cacheGetUserDevices.mockResolvedValue(JSON.stringify(cached))

      const result = await deviceService.getDevices(userId, 'dev-1')

      expect(result).toHaveLength(1)
      expect(result[0].deviceName).toBe('iPhone')
      expect(result[0].lastActiveAt).toBeInstanceOf(Date)
      expect(deviceFindByUserId).not.toHaveBeenCalled()
    })

    it('fetches from DB and caches when cache miss', async () => {
      cacheGetUserDevices.mockResolvedValue(null)
      const devices = [
        makeDevice({ id: registryId1, deviceId: 'dev-1', deviceName: 'iPhone' }),
      ]
      const sessions = [makeSession({ id: 's1', deviceId: 'dev-1' })]
      deviceFindByUserId.mockResolvedValue(devices)
      sessionFindActiveByUserId.mockResolvedValue(sessions)

      const result = await deviceService.getDevices(userId, 'dev-1')

      expect(result).toHaveLength(1)
      expect(result[0].isCurrentDevice).toBe(true)
      expect(result[0].lastActiveTimeAgo).toBeDefined()
      expect(cacheSetUserDevices).toHaveBeenCalledWith(userId, expect.any(String))
    })

    it('marks current device correctly', async () => {
      cacheGetUserDevices.mockResolvedValue(null)
      const devices = [
        makeDevice({ id: registryId1, deviceId: 'dev-1', deviceName: 'iPhone' }),
        makeDevice({ id: registryId2, deviceId: 'dev-2', deviceName: 'MacBook' }),
      ]
      const sessions = [
        makeSession({ deviceId: 'dev-1' }),
        makeSession({ deviceId: 'dev-2' }),
      ]
      deviceFindByUserId.mockResolvedValue(devices)
      sessionFindActiveByUserId.mockResolvedValue(sessions)

      const result = await deviceService.getDevices(userId, 'dev-2')

      expect(result[0].isCurrentDevice).toBe(false)
      expect(result[1].isCurrentDevice).toBe(true)
    })

    it('only includes devices with active session', async () => {
      cacheGetUserDevices.mockResolvedValue(null)
      const devices = [
        makeDevice({ deviceId: 'dev-1' }),
        makeDevice({ deviceId: 'dev-2' }),
      ]
      const sessions = [makeSession({ deviceId: 'dev-1' })]
      deviceFindByUserId.mockResolvedValue(devices)
      sessionFindActiveByUserId.mockResolvedValue(sessions)

      const result = await deviceService.getDevices(userId)

      expect(result).toHaveLength(1)
      expect(result[0].deviceId).toBe('dev-1')
    })
  })

  describe('revokeDevice', () => {
    it('revokes device and returns success', async () => {
      const device = makeDevice({
        id: registryId2,
        deviceId: 'dev-2',
        deviceName: 'MacBook',
      })
      deviceFindById.mockResolvedValue(device)
      sessionFindActiveByUserIdAndDeviceId.mockResolvedValue({
        id: 's2',
        deviceId: 'dev-2',
        deviceName: 'MacBook',
        lastActiveAt: new Date(),
      })
      sessionRevokeById.mockResolvedValue(undefined)
      sessionCountActiveByUserId.mockResolvedValue(1)

      const result = await deviceService.revokeDevice(
        userId,
        registryId2,
        currentDeviceId,
      )

      expect(result.success).toBe(true)
      expect(result.revokedDeviceName).toBe('MacBook')
      expect(result.remainingDevices).toBe(1)
      expect(sessionRevokeById).toHaveBeenCalledWith('s2')
      expect(redisDel).toHaveBeenCalled()
      expect(cacheInvalidateUserDevicesAndSessions).toHaveBeenCalledWith(userId)
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'DEVICE_REVOKED',
          actionStatus: 'success',
          actionDetails: expect.objectContaining({ deviceName: 'MacBook' }),
        }),
      )
    })

    it('throws DEVICE_NOT_FOUND when device missing', async () => {
      deviceFindById.mockResolvedValue(null)

      await expect(
        deviceService.revokeDevice(userId, 'bad-id', currentDeviceId),
      ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', statusCode: 404 })
    })

    it('throws DEVICE_NOT_FOUND when device belongs to another user', async () => {
      deviceFindById.mockResolvedValue(makeDevice({ userId: 'other-user' }))

      await expect(
        deviceService.revokeDevice(userId, registryId2, 'other-device'),
      ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', statusCode: 404 })
    })

    it('throws CANNOT_REVOKE_CURRENT_DEVICE when revoking current', async () => {
      const device = makeDevice({ deviceId: currentDeviceId })
      deviceFindById.mockResolvedValue(device)

      await expect(
        deviceService.revokeDevice(userId, registryId1, currentDeviceId),
      ).rejects.toMatchObject({
        code: 'CANNOT_REVOKE_CURRENT_DEVICE',
        statusCode: 400,
      })
    })
  })

  describe('logoutAllOtherDevices', () => {
    it('revokes all other sessions when password correct', async () => {
      secFindByUserId.mockResolvedValue({ passwordHash: 'hash' })
      passwordCompare.mockResolvedValue(true)
      sessionFindActiveByUserId.mockResolvedValue([
        makeSession({ deviceId: 'dev-1', id: 's1' }),
        makeSession({ deviceId: 'dev-2', deviceName: 'MacBook', id: 's2' }),
        makeSession({ deviceId: 'dev-3', deviceName: 'Chrome', id: 's3' }),
      ])
      sessionRevokeById.mockResolvedValue(undefined)

      const result = await deviceService.logoutAllOtherDevices(
        userId,
        'MyPassword!',
        'dev-1',
      )

      expect(result.success).toBe(true)
      expect(result.revokedCount).toBe(2)
      expect(result.remainingDevices).toBe(1)
      expect(result.revokedDevices).toHaveLength(2)
      expect(sessionRevokeById).toHaveBeenCalledTimes(2)
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'ALL_DEVICES_REVOKED',
          actionDetails: expect.objectContaining({ revokedCount: 2 }),
        }),
      )
    })

    it('throws SECURITY_PASSWORD_INCORRECT when password wrong', async () => {
      secFindByUserId.mockResolvedValue({ passwordHash: 'hash' })
      passwordCompare.mockResolvedValue(false)

      await expect(
        deviceService.logoutAllOtherDevices(userId, 'Wrong', currentDeviceId),
      ).rejects.toMatchObject({
        code: 'SECURITY_PASSWORD_INCORRECT',
        statusCode: 401,
      })
    })

    it('throws SECURITY_PASSWORD_NOT_SET when no security password', async () => {
      secFindByUserId.mockResolvedValue(null)

      await expect(
        deviceService.logoutAllOtherDevices(userId, 'pass', currentDeviceId),
      ).rejects.toMatchObject({
        code: 'SECURITY_PASSWORD_NOT_SET',
        statusCode: 400,
      })
    })

    it('throws NO_OTHER_DEVICES when only current device', async () => {
      secFindByUserId.mockResolvedValue({ passwordHash: 'hash' })
      passwordCompare.mockResolvedValue(true)
      sessionFindActiveByUserId.mockResolvedValue([
        makeSession({ deviceId: currentDeviceId }),
      ])

      await expect(
        deviceService.logoutAllOtherDevices(userId, 'pass', currentDeviceId),
      ).rejects.toMatchObject({
        code: 'NO_OTHER_DEVICES',
        statusCode: 400,
      })
    })
  })

  describe('renameDevice', () => {
    it('updates name (relies on short TTL device cache)', async () => {
      const device = makeDevice({ id: registryId1 })
      deviceFindById.mockResolvedValue(device)
      deviceUpdate.mockResolvedValue({ ...device, deviceName: 'My iPhone' })

      const result = await deviceService.renameDevice(
        userId,
        registryId1,
        'My iPhone',
      )

      expect(result.success).toBe(true)
      expect(result.deviceName).toBe('My iPhone')
      expect(deviceUpdate).toHaveBeenCalledWith(registryId1, {
        deviceName: 'My iPhone',
      })
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'DEVICE_RENAMED',
          actionDetails: expect.objectContaining({ newName: 'My iPhone' }),
        }),
      )
    })

    it('throws DEVICE_NOT_FOUND when device missing', async () => {
      deviceFindById.mockResolvedValue(null)

      await expect(
        deviceService.renameDevice(userId, 'bad-id', 'New Name'),
      ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', statusCode: 404 })
    })

    it('throws DEVICE_NOT_FOUND when device belongs to another user', async () => {
      deviceFindById.mockResolvedValue(makeDevice({ userId: 'other' }))

      await expect(
        deviceService.renameDevice(userId, registryId1, 'New'),
      ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', statusCode: 404 })
    })
  })
})
