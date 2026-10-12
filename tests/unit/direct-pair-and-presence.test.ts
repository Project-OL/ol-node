import { describe, it, expect, vi } from 'vitest'
import { makeDirectPairKey } from '../../src/utils/direct-pair-key'

describe('makeDirectPairKey', () => {
  it('sorts UUIDs lexicographically', () => {
    const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    expect(makeDirectPairKey(a, b)).toBe(`${a}:${b}`)
    expect(makeDirectPairKey(b, a)).toBe(`${a}:${b}`)
  })

  it('rejects identical users', () => {
    const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    expect(() => makeDirectPairKey(a, a)).toThrow(/distinct/)
  })
})

async function loadMessagingWith(opts: {
  searchByPublicId: ReturnType<typeof vi.fn>
  userFindUnique?: ReturnType<typeof vi.fn>
}) {
    vi.resetModules()
    vi.doMock('../../src/services/userSearch.service', () => ({
      userSearchService: { searchByPublicId: opts.searchByPublicId },
    }))
    vi.doMock('../../src/repositories/conversation.repository', () => ({
      conversationRepository: {
        findDirectConversationIncludingDeleted: vi.fn(),
        createConversation: vi.fn(),
        findConversationById: vi.fn(),
        lockDirectPair: vi.fn(),
        reactivateMember: vi.fn(),
      },
    }))
    vi.doMock('../../src/services/cache.service', () => ({
      cacheService: { delete: vi.fn() },
    }))
    vi.doMock('../../src/config/redis', () => ({
      redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn(), on: vi.fn() },
      RedisKeys: {
        userConversations: (id: string) => `user:${id}:conversations`,
        allowedMessaging: () => 'allowed',
      },
      MSG_HOT_TTL: 1,
      MSG_HOT_CACHE_SIZE: 1,
      CONV_LIST_TTL: 1,
      CONV_MEMBER_CACHE_TTL_SEC: 1,
      TYPING_THROTTLE_TTL_SEC: 1,
      TYPING_INDICATOR_TTL_SEC: 1,
      RECORDING_THROTTLE_TTL_SEC: 1,
      RECORDING_INDICATOR_TTL_SEC: 1,
      READ_RECEIPT_DEBOUNCE_MS: 1,
    }))
    vi.doMock('../../src/config/database', () => ({
      prisma: { $transaction: vi.fn(), user: { findUnique: opts.userFindUnique ?? vi.fn() } },
      prismaRead: {},
    }))
    vi.doMock('../../src/repositories/block.repository', () => ({
      blockRepository: { isBlocked: vi.fn() },
    }))
    vi.doMock('../../src/services/userSettings.service', () => ({
      userSettingsService: { getOrCreateSettings: vi.fn() },
    }))
    vi.doMock('../../src/repositories/follow.repository', () => ({
      followRepository: { existsFollow: vi.fn() },
    }))
    vi.doMock('../../src/services/block.service', () => ({ blockService: {} }))
    vi.doMock('../../src/services/follow.service', () => ({ followService: {} }))
    vi.doMock('../../src/services/audit.service', () => ({ auditService: { log: vi.fn() } }))
    vi.doMock('../../src/services/userRestriction.service', () => ({
      userRestrictionService: { assertNotRestricted: vi.fn() },
    }))

    const { messagingService } = await import('../../src/services/messaging.service')
    return messagingService
}

describe('messagingService.getOrCreateDirectConversation self-guard', () => {
  const initiatorId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

  it('rejects self DM with CANNOT_MESSAGE_SELF', async () => {
    const searchByPublicId = vi.fn().mockResolvedValue({ userId: initiatorId, isAgency: false })
    const userFindUnique = vi.fn()
    const messagingService = await loadMessagingWith({ searchByPublicId, userFindUnique })
    await expect(
      messagingService.getOrCreateDirectConversation(initiatorId, '34216592'),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CANNOT_MESSAGE_SELF',
    })
    // A numeric id never takes the UUID lookup.
    expect(userFindUnique).not.toHaveBeenCalled()
    expect(searchByPublicId).toHaveBeenCalledWith('34216592', initiatorId)
  })

  it('resolves a user UUID (old live-room cards) to its public id, then runs the same checks', async () => {
    const searchByPublicId = vi.fn().mockResolvedValue({ userId: initiatorId, isAgency: false })
    const userFindUnique = vi.fn().mockResolvedValue({ publicId: 34220465n })
    const messagingService = await loadMessagingWith({ searchByPublicId, userFindUnique })
    const recipientUuid = 'f803f7d8-2e92-40ff-8ef5-406be24c8824'
    // Recipient resolves to the caller, so the self-guard still fires through the UUID path.
    await expect(
      messagingService.getOrCreateDirectConversation(initiatorId, recipientUuid),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CANNOT_MESSAGE_SELF' })
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: recipientUuid },
      select: { publicId: true },
    })
    expect(searchByPublicId).toHaveBeenCalledWith('34220465', initiatorId)
  })

  it('returns 404 NOT_FOUND for an unknown user UUID', async () => {
    const searchByPublicId = vi.fn()
    const userFindUnique = vi.fn().mockResolvedValue(null)
    const messagingService = await loadMessagingWith({ searchByPublicId, userFindUnique })
    await expect(
      messagingService.getOrCreateDirectConversation(
        initiatorId,
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' })
    expect(searchByPublicId).not.toHaveBeenCalled()
  })
})

describe('presenceService.refreshOnlineHeartbeat', () => {
  it('re-publishes online when key was missing', async () => {
    vi.resetModules()
    const get = vi.fn().mockResolvedValue(null)
    const set = vi.fn().mockResolvedValue('OK')
    const publish = vi.fn().mockResolvedValue(1)

    vi.doMock('../../src/config/redis', () => ({
      redisClient: {
        get,
        set,
        publish,
        eval: vi.fn(),
        del: vi.fn(),
        mget: vi.fn(),
      },
      RedisKeys: {
        userOnlineStatus: (id: string) => `online:${id}`,
        presenceCount: (id: string) => `presence:count:${id}`,
        presenceChannel: (id: string) => `presence:user:${id}`,
        userLastActivePresence: (id: string) => `user:lastActive:presence:${id}`,
      },
      PRESENCE_HEARTBEAT_TTL_SEC: 60,
      PRESENCE_LAST_ACTIVE_THROTTLE_TTL_SEC: 30,
    }))
    vi.doMock('../../src/services/privacy.service', () => ({
      privacyService: { getEffectiveFlagsBulk: vi.fn() },
    }))
    vi.doMock('../../src/config/database', () => ({
      prismaRead: { user: { findMany: vi.fn(), updateMany: vi.fn() } },
      prisma: { user: { updateMany: vi.fn() } },
    }))
    vi.doMock('../../src/middlewares/lastActiveTracker.middleware', () => ({
      touchUserLastActive: vi.fn().mockResolvedValue(undefined),
    }))

    const { presenceService } = await import('../../src/services/presence.service')
    await presenceService.refreshOnlineHeartbeat('user-1')

    expect(set).toHaveBeenCalled()
    expect(publish).toHaveBeenCalled()
  })
})
