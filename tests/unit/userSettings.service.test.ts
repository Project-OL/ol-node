import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisGet = vi.fn()
const redisSet = vi.fn()
const redisDel = vi.fn()

vi.mock('../../src/config/redis', () => ({
  RedisKeys: {
    userSettings: (userId: string) => `user:${userId}:settings`,
  },
  redisClient: {
    get: (...args: unknown[]) => redisGet(...args),
    set: (...args: unknown[]) => redisSet(...args),
    del: (...args: unknown[]) => redisDel(...args),
  },
}))

const upsertSettings = vi.fn()
vi.mock('../../src/repositories/userSettings.repository', () => ({
  userSettingsRepository: {
    upsertSettings: (...args: unknown[]) => upsertSettings(...args),
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

const { userSettingsService } = await import('../../src/services/userSettings.service')

const userId = 'user-123'

function makeSettings(overrides: Partial<{
  id: string
  userId: string
  language: string
  allowMsgFromMutual: boolean
  allowMsgFromFollowing: boolean
  allowMsgFromStranger: boolean
  createdAt: Date
  updatedAt: Date
}> = {}) {
  return {
    id: 'settings-1',
    userId,
    language: 'en',
    allowMsgFromMutual: true,
    allowMsgFromFollowing: true,
    allowMsgFromStranger: false,
    createdAt: new Date('2026-03-10T00:00:00Z'),
    updatedAt: new Date('2026-03-10T00:00:00Z'),
    ...overrides,
  }
}

describe('userSettingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getOrCreateSettings', () => {
    it('returns settings from cache when present', async () => {
      const cached = {
        id: 'settings-1',
        userId,
        language: 'en',
        allowMsgFromMutual: true,
        allowMsgFromFollowing: true,
        allowMsgFromStranger: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      cacheGet.mockResolvedValue(JSON.stringify(cached))

      const result = await userSettingsService.getOrCreateSettings(userId)

      expect(result.language).toBe('en')
      expect(upsertSettings).not.toHaveBeenCalled()
    })

    it('upserts and caches when not in cache', async () => {
      cacheGet.mockResolvedValue(null)
      const settings = makeSettings()
      upsertSettings.mockResolvedValue(settings)

      const result = await userSettingsService.getOrCreateSettings(userId)

      expect(upsertSettings).toHaveBeenCalledWith(userId, {})
      expect(cacheSet).toHaveBeenCalledWith(
        `user:${userId}:settings`,
        expect.any(String),
        3600,
      )
      expect(result.language).toBe('en')
    })
  })

  describe('updateLanguage', () => {
    it('updates language when valid and audits', async () => {
      const updated = makeSettings({ language: 'ne' })
      upsertSettings.mockResolvedValue(updated)

      const result = await userSettingsService.updateLanguage(userId, 'ne', {
        request: { ip: '127.0.0.1', headers: {} },
        deviceId: 'dev-1',
      })

      expect(upsertSettings).toHaveBeenCalledWith(userId, { language: 'ne' })
      expect(cacheDelete).toHaveBeenCalledWith(`user:${userId}:settings`)
      expect(result.language).toBe('ne')
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'USER_LANGUAGE_UPDATED',
          actionStatus: 'success',
          userId,
          actionDetails: { language: 'ne' },
        }),
      )
    })

    it('throws INVALID_LANGUAGE on bad value', async () => {
      // @ts-expect-error deliberate invalid value in test
      await expect(userSettingsService.updateLanguage(userId, 'fr', {})).rejects.toMatchObject({
        code: 'INVALID_LANGUAGE',
        statusCode: 400,
      })
    })
  })

  describe('updateMessagePrivacy', () => {
    it('updates partial flags and audits changed fields', async () => {
      const updated = makeSettings({
        allowMsgFromMutual: false,
        allowMsgFromFollowing: true,
        allowMsgFromStranger: true,
      })
      upsertSettings.mockResolvedValue(updated)

      const result = await userSettingsService.updateMessagePrivacy(
        userId,
        { allowMsgFromMutual: false, allowMsgFromStranger: true },
        { request: { ip: '1.1.1.1', headers: {} }, deviceId: 'dev-1' },
      )

      expect(upsertSettings).toHaveBeenCalledWith(userId, {
        allowMsgFromMutual: false,
        allowMsgFromStranger: true,
      })
      expect(cacheDelete).toHaveBeenCalledWith(`user:${userId}:settings`)
      expect(result.allowMsgFromMutual).toBe(false)
      expect(result.allowMsgFromStranger).toBe(true)
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'USER_MESSAGE_PRIVACY_UPDATED',
          actionStatus: 'success',
          actionDetails: {
            allowMsgFromMutual: false,
            allowMsgFromStranger: true,
          },
        }),
      )
    })

    it('throws NO_UPDATE_FIELDS when no flags provided', async () => {
      await expect(
        userSettingsService.updateMessagePrivacy(userId, {}, {}),
      ).rejects.toMatchObject({
        code: 'NO_UPDATE_FIELDS',
        statusCode: 400,
      })
    })
  })
})

