import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  findConversationById: vi.fn(),
  markConversationDeleted: vi.fn(),
  sendMessageWithOutbox: vi.fn(),
  markAsRead: vi.fn(),
  updateReadCursor: vi.fn(),
  listMessagesDb: vi.fn(),
  findMessageById: vi.fn(),
    removeReaction: vi.fn(),
    upsertReaction: vi.fn(),
    softDeleteMessage: vi.fn(),
  zrevrange: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  deleteCache: vi.fn(),
  publishToConversation: vi.fn(),
  prismaReadMessageFindFirst: vi.fn(),
  prismaReadMessageFindUnique: vi.fn(),
  prismaReadMemberFindUnique: vi.fn(),
  prismaReadMemberFindMany: vi.fn(),
  prismaMemberUpdate: vi.fn(),
  agencyCoinsellerFindUnique: vi.fn(),
  enqueueAutoReply: vi.fn(),
}))

vi.mock('../../src/repositories/conversation.repository', () => ({
  conversationRepository: {
    findConversationById: (...a: unknown[]) => mocks.findConversationById(...a),
    markConversationDeleted: (...a: unknown[]) => mocks.markConversationDeleted(...a),
  },
}))

vi.mock('../../src/repositories/message.repository', () => ({
  messageRepository: {
    sendMessageWithOutbox: (...a: unknown[]) => mocks.sendMessageWithOutbox(...a),
    markAsRead: (...a: unknown[]) => mocks.markAsRead(...a),
    updateReadCursor: (...a: unknown[]) => mocks.updateReadCursor(...a),
    listMessages: (...a: unknown[]) => mocks.listMessagesDb(...a),
    findMessageById: (...a: unknown[]) => mocks.findMessageById(...a),
    removeReaction: (...a: unknown[]) => mocks.removeReaction(...a),
    upsertReaction: (...a: unknown[]) => mocks.upsertReaction(...a),
    softDeleteMessage: (...a: unknown[]) => mocks.softDeleteMessage(...a),
  },
  // Named export (not on messageRepository) — identity passthrough is enough
  // since these tests don't assert on gift/post metadata enrichment.
  attachMessageExtrasFromMetadata: (msg: unknown) => msg,
}))

vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    delete: (...a: unknown[]) => mocks.deleteCache(...a),
  },
}))

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    zrevrange: (...a: unknown[]) => mocks.zrevrange(...a),
    set: (...a: unknown[]) => mocks.set(...a),
    del: (...a: unknown[]) => mocks.del(...a),
    zadd: vi.fn(),
    expire: vi.fn(),
    zremrangebyrank: vi.fn(),
    pipeline: vi.fn(() => ({
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      zremrangebyrank: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
    incr: vi.fn(),
    get: vi.fn(),
    mget: vi.fn(),
  },
  RedisKeys: {
    convMessages: (id: string) => `conv:${id}:messages`,
    unreadCount: (uid: string, cid: string) => `unread:${uid}:${cid}`,
    userConversations: (uid: string) => `user:${uid}:conversations`,
    convMember: (cid: string, uid: string) => `conv:member:${cid}:${uid}`,
  },
  MSG_HOT_TTL: 7200,
  MSG_HOT_CACHE_SIZE: 40,
  CONV_LIST_TTL: 300,
  CONV_MEMBER_CACHE_TTL_SEC: 60,
  TYPING_THROTTLE_TTL_SEC: 2,
  TYPING_INDICATOR_TTL_SEC: 8,
  READ_RECEIPT_DEBOUNCE_MS: 5000,
}))

vi.mock('../../src/utils/ws-publisher', () => ({
  publishToConversation: (...a: unknown[]) => mocks.publishToConversation(...a),
  publishServerFrameToConversation: vi.fn(),
}))

vi.mock('../../src/queues/messaging.queue', () => ({
  enqueueMessageOutboxPublish: vi.fn(),
}))

vi.mock('../../src/queues/message-media-audio.queue', () => ({
  enqueueMessageMediaAudioProcessing: vi.fn(),
}))

vi.mock('../../src/queues/agencyAutoReply.queue', () => ({
  enqueueAutoReply: (...a: unknown[]) => mocks.enqueueAutoReply(...a),
}))

vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: vi.fn() },
}))

vi.mock('../../src/config/database', () => ({
  prismaRead: {
    message: {
      findFirst: (...a: unknown[]) => mocks.prismaReadMessageFindFirst(...a),
      findUnique: (...a: unknown[]) => mocks.prismaReadMessageFindUnique(...a),
    },
    conversationMember: {
      findUnique: (...a: unknown[]) => mocks.prismaReadMemberFindUnique(...a),
      findMany: (...a: unknown[]) => mocks.prismaReadMemberFindMany(...a),
    },
    agencyCoinseller: {
      findUnique: (...a: unknown[]) => mocks.agencyCoinsellerFindUnique(...a),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
  prisma: {
    conversationMember: {
      update: (...a: unknown[]) => mocks.prismaMemberUpdate(...a),
    },
  },
}))

vi.mock('../../src/repositories/block.repository', () => ({
  blockRepository: { isBlocked: vi.fn().mockResolvedValue(false) },
}))

vi.mock('../../src/services/userSettings.service', () => ({
  userSettingsService: {
    getOrCreateSettings: vi.fn().mockResolvedValue({
      allowMsgFromMutual: true,
      allowMsgFromFollowing: true,
      allowMsgFromStranger: true,
    }),
  },
}))

vi.mock('../../src/repositories/follow.repository', () => ({
  followRepository: { existsFollow: vi.fn().mockResolvedValue(true) },
}))

vi.mock('../../src/services/userRestriction.service', () => ({
  userRestrictionService: {
    assertNotRestricted: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../src/services/message-send-media.service', () => ({
  assertMessageTypeMediaAlignment: vi.fn(),
  prepareMediaItemsForSend: vi.fn(),
}))

import { messagingService, buildAutoReplyClientMessageId } from '../../src/services/messaging.service'
import { processAgencyAutoReplyJob } from '../../src/jobs/agencyAutoReply.job'

describe('messaging negative scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.set.mockResolvedValue('OK')
    mocks.markAsRead.mockResolvedValue(undefined)
    mocks.deleteCache.mockResolvedValue(undefined)
    mocks.publishToConversation.mockResolvedValue(undefined)
  })

  describe('listMessages — Redis hot cache path', () => {
    const convId = 'conv-1'
    const userId = 'user-1'

    it('uses Redis cache when history is not cleared and cache has a full page', async () => {
      mocks.findConversationById.mockResolvedValue({
        id: convId,
        members: [{ userId, deletedAt: null }],
      })
      const cachedMsg = {
        id: 'msg-1',
        conversationId: convId,
        content: 'hello',
        createdAt: new Date().toISOString(),
        seq: '1',
      }
      const fullPage = Array.from({ length: 30 }, (_, i) => {
        const idx = 29 - i
        return [JSON.stringify({ ...cachedMsg, id: `msg-${idx}` }), String(idx + 1)]
      }).flat()
      mocks.zrevrange.mockResolvedValue(fullPage)
      mocks.updateReadCursor.mockResolvedValue(true)

      const result = await messagingService.listMessages(userId, convId)

      expect(result.messages).toHaveLength(30)
      expect(mocks.listMessagesDb).not.toHaveBeenCalled()
      expect(mocks.updateReadCursor).toHaveBeenCalledWith(convId, userId, 'msg-29')
      expect(mocks.markAsRead).not.toHaveBeenCalled()
    })

    it('falls through to DB and warms cache when Redis has only a partial page', async () => {
      mocks.findConversationById.mockResolvedValue({
        id: convId,
        members: [{ userId, deletedAt: null }],
      })
      const cachedMsg = {
        id: 'msg-new',
        conversationId: convId,
        content: 'just sent',
        createdAt: new Date().toISOString(),
        seq: '99',
      }
      mocks.zrevrange.mockResolvedValue([JSON.stringify(cachedMsg), '99'])
      const dbMessages = Array.from({ length: 30 }, (_, i) => ({
        id: `msg-${i}`,
        conversationId: convId,
        content: `m${i}`,
        createdAt: new Date(),
        seq: BigInt(i + 1),
      }))
      mocks.listMessagesDb.mockResolvedValue({ messages: dbMessages, nextCursor: null })
      mocks.updateReadCursor.mockResolvedValue(true)

      const result = await messagingService.listMessages(userId, convId)

      expect(result.messages).toHaveLength(30)
      expect(mocks.listMessagesDb).toHaveBeenCalledWith(convId, userId, undefined, 40)
    })

    it('skips Redis cache when member has deletedAt (cleared history)', async () => {
      mocks.findConversationById.mockResolvedValue({
        id: convId,
        members: [{ userId, deletedAt: new Date('2026-01-01') }],
      })
      mocks.listMessagesDb.mockResolvedValue({ messages: [], nextCursor: null })
      mocks.updateReadCursor.mockResolvedValue(false)

      await messagingService.listMessages(userId, convId)

      expect(mocks.zrevrange).not.toHaveBeenCalled()
      expect(mocks.listMessagesDb).toHaveBeenCalledWith(convId, userId, undefined, 30)
    })

    it('falls through to DB when Redis cache is empty', async () => {
      mocks.findConversationById.mockResolvedValue({
        id: convId,
        members: [{ userId }],
      })
      mocks.zrevrange.mockResolvedValue([])
      mocks.listMessagesDb.mockResolvedValue({ messages: [], nextCursor: null })

      await messagingService.listMessages(userId, convId)

      expect(mocks.listMessagesDb).toHaveBeenCalledWith(convId, userId, undefined, 40)
    })

    it('rejects non-members', async () => {
      mocks.findConversationById.mockResolvedValue(null)
      await expect(messagingService.listMessages(userId, convId)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      })
    })
  })

  describe('clearChatHistory', () => {
    it('marks conversation deleted and busts message hot cache', async () => {
      mocks.findConversationById.mockResolvedValue({
        id: 'conv-1',
        type: 'DIRECT',
        members: [{ userId: 'user-1', deletedAt: null }],
      })
      mocks.markConversationDeleted.mockResolvedValue(undefined)

      await messagingService.clearChatHistory('user-1', 'conv-1')

      expect(mocks.markConversationDeleted).toHaveBeenCalledWith('conv-1', 'user-1')
      expect(mocks.deleteCache).toHaveBeenCalledWith('user:user-1:conversations')
      expect(mocks.del).toHaveBeenCalledWith('conv:conv-1:messages')
    })
  })

  describe('reactions cache invalidation', () => {
    it('addReaction busts message cache', async () => {
      mocks.findMessageById.mockResolvedValue({ id: 'm1', conversationId: 'conv-1' })
      await messagingService.addReaction('user-1', 'm1', '👍')
      expect(mocks.deleteCache).toHaveBeenCalledWith('conv:conv-1:messages')
    })

    it('removeReaction busts message cache', async () => {
      mocks.findMessageById.mockResolvedValue({ id: 'm1', conversationId: 'conv-1' })
      await messagingService.removeReaction('user-1', 'm1', '👍')
      expect(mocks.deleteCache).toHaveBeenCalledWith('conv:conv-1:messages')
    })
  })

  describe('deleteMessage', () => {
    it('rejects when message not found', async () => {
      mocks.softDeleteMessage.mockRejectedValue(
        Object.assign(new Error('not found'), { statusCode: 404, code: 'NOT_FOUND' }),
      )
      await expect(messagingService.deleteMessage('user-1', 'missing')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })
  })

  describe('sendMessage — TEXT_COINS auto-reply', () => {
    const convId = 'conv-coins'
    const customerId = 'customer-1'
    const agentId = 'agent-1'
    const duplicateMsg = {
      id: 'msg-dup',
      conversationId: convId,
      seq: BigInt(7),
      type: 'TEXT_COINS',
      content: 'Need coins',
      createdAt: new Date(),
      mediaItems: [],
    }

    beforeEach(() => {
      mocks.findConversationById.mockResolvedValue({
        id: convId,
        members: [{ userId: customerId }, { userId: agentId }],
      })
      mocks.sendMessageWithOutbox.mockResolvedValue({
        status: 'duplicate',
        message: duplicateMsg,
      })
      mocks.prismaReadMemberFindMany.mockResolvedValue([
        { userId: agentId, user: { id: agentId, isAgent: true } },
        { userId: customerId, user: { id: customerId, isAgent: false } },
      ])
      mocks.agencyCoinsellerFindUnique.mockResolvedValue({
        autoReply: 'Thanks, we will assist you shortly.',
      })
      mocks.enqueueAutoReply.mockResolvedValue(undefined)
    })

    it('enqueues auto-reply even when send returns duplicate (idempotent retry)', async () => {
      await messagingService.sendMessage(customerId, convId, {
        type: 'TEXT_COINS',
        content: 'Need coins',
        clientMessageId: 'client-dup-1',
      })
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(mocks.enqueueAutoReply).toHaveBeenCalledWith({
        conversationId: convId,
        agencyUserId: agentId,
        autoReplyText: 'Thanks, we will assist you shortly.',
        triggerMessageSeq: 7,
      })
    })
  })

  describe('flushReadReceipt (WS READ path)', () => {
    it('does not publish READ when updateReadCursor returns false', async () => {
      mocks.updateReadCursor.mockResolvedValue(false)
      const { publishServerFrameToConversation } = await import('../../src/utils/ws-publisher')
      await messagingService.flushReadReceipt('user-1', 'conv-1', 'msg-1')
      expect(publishServerFrameToConversation).not.toHaveBeenCalled()
    })

    it('zeros unread and publishes READ when cursor advances', async () => {
      mocks.updateReadCursor.mockResolvedValue(true)
      const { publishServerFrameToConversation } = await import('../../src/utils/ws-publisher')
      await messagingService.flushReadReceipt('user-1', 'conv-1', 'msg-1')
      expect(mocks.set).toHaveBeenCalledWith('unread:user-1:conv-1', '0', 'EX', 86400)
      expect(publishServerFrameToConversation).toHaveBeenCalledWith('conv-1', {
        t: 'READ',
        conversationId: 'conv-1',
        userId: 'user-1',
        lastReadMessageId: 'msg-1',
      })
    })
  })
})

describe('agency auto-reply job negative scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips when auto-reply row already exists for deterministic clientMessageId', async () => {
    mocks.prismaReadMessageFindFirst.mockResolvedValue({ id: 'existing' })
    const sendAutoReplySpy = vi.spyOn(messagingService, 'sendAutoReply').mockResolvedValue()

    await processAgencyAutoReplyJob({
      id: 'job-1',
      data: {
        conversationId: 'conv-1',
        agencyUserId: 'agent-1',
        autoReplyText: 'Hello',
        triggerMessageSeq: 5,
      },
    } as never)

    expect(sendAutoReplySpy).not.toHaveBeenCalled()
    expect(mocks.prismaReadMessageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId: 'conv-1',
          clientMessageId: buildAutoReplyClientMessageId('conv-1', 5),
        },
      }),
    )
    sendAutoReplySpy.mockRestore()
  })

  it('sends auto-reply when no prior reply at trigger seq', async () => {
    mocks.prismaReadMessageFindFirst.mockResolvedValue(null)
    const sendAutoReplySpy = vi.spyOn(messagingService, 'sendAutoReply').mockResolvedValue()

    await processAgencyAutoReplyJob({
      id: 'job-2',
      data: {
        conversationId: 'conv-1',
        agencyUserId: 'agent-1',
        autoReplyText: 'Thanks for your inquiry',
        triggerMessageSeq: 5,
      },
    } as never)

    expect(sendAutoReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        senderUserId: 'agent-1',
        content: 'Thanks for your inquiry',
        clientMessageId: buildAutoReplyClientMessageId('conv-1', 5),
      }),
    )
    sendAutoReplySpy.mockRestore()
  })
})
