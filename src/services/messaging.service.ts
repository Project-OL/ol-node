import { conversationRepository } from '../repositories/conversation.repository'
import { messageRepository, type MessageWithDetails } from '../repositories/message.repository'
import { blockRepository } from '../repositories/block.repository'
import { followRepository } from '../repositories/follow.repository'
import { userSettingsService } from './userSettings.service'
import { followService } from './follow.service'
import { cacheService } from './cache.service'
import { auditService } from './audit.service'
import { userSearchService } from './userSearch.service'
import { privacyService } from './privacy.service'
import { redisClient } from '../config/redis'
import {
  RedisKeys,
  MSG_HOT_TTL,
  MSG_HOT_CACHE_SIZE,
  CONV_LIST_TTL,
  CONV_MEMBER_CACHE_TTL_SEC,
  TYPING_THROTTLE_TTL_SEC,
  TYPING_INDICATOR_TTL_SEC,
  READ_RECEIPT_DEBOUNCE_MS,
} from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { MediaProcessingStatus } from '@prisma/client'
import { publishServerFrameToConversation, publishToConversation } from '../utils/ws-publisher'
import { enqueueMessageOutboxPublish } from '../queues/messaging.queue'
import { enqueueMessageMediaAudioProcessing } from '../queues/message-media-audio.queue'
import { enqueueAutoReply } from '../queues/agencyAutoReply.queue'
import { prismaRead } from '../config/database'
import { rootLogger } from '../utils/rootLogger'
import type { SendMessageInput } from '../models/messaging.schemas'
import { s3Bucket } from '../config/s3'
import type { MediaItemInput, SendMessageWithOutboxResult } from '../repositories/message.repository'
import {
  assertMessageTypeMediaAlignment,
  prepareMediaItemsForSend,
} from './message-send-media.service'

export type DmContact = {
  userId: string
  username: string
  name: string
  publicId: string
  displayPublicId: string
  avatar: string | null
  isOnline: boolean
  isMutual: boolean
  existingConversationId: string | null
}

export type PaginatedMessages = {
  messages: MessageWithDetails[]
  nextCursor: string | null
}

export type PaginatedConversations = {
  conversations: Awaited<
    ReturnType<typeof conversationRepository.listConversationsForUser>
  >['conversations']
  nextCursor: string | null
}

type ReadDebounceEntry = {
  timer: ReturnType<typeof setTimeout>
  lastReadMessageId: string
}

const readReceiptDebounce = new Map<string, ReadDebounceEntry>()
const messagingLog = rootLogger.child({ module: 'messaging' })

export type CanUserMessageOptions = {
  /**
   * When true, only block checks apply (TEXT_COINS / coinseller agent thread).
   * Skips allowMsgFromMutual / allowMsgFromFollowing / allowMsgFromStranger.
   */
  bypassDmPrivacy?: boolean
}

async function shouldBypassDmPrivacyForSend(params: {
  messageType: string
  senderId: string
  conversationId: string
}): Promise<boolean> {
  if (params.messageType === 'TEXT_COINS') return true

  const sender = await prismaRead.user.findUnique({
    where: { id: params.senderId },
    select: { isAgent: true },
  })
  if (!sender?.isAgent) return false

  return messageRepository.conversationHasTextCoins(params.conversationId)
}

async function maybeEnqueueAutoReply(conversationId: string, triggerSeq: bigint): Promise<void> {
  const members = await prismaRead.conversationMember.findMany({
    where: { conversationId },
    include: { user: { select: { id: true, isAgent: true } } },
  })
  const agencyMember = members.find((m) => m.user.isAgent)
  if (!agencyMember) return

  const settings = await prismaRead.agencyCoinseller.findUnique({
    where: { agencyUserId: agencyMember.userId },
    select: { autoReply: true },
  })
  if (!settings?.autoReply) return

  await enqueueAutoReply({
    conversationId,
    agencyUserId: agencyMember.userId,
    autoReplyText: settings.autoReply,
    triggerMessageSeq: Number(triggerSeq),
  })
}

function readReceiptDebounceKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`
}

function mediaItemsWithServerBucket(items: MediaItemInput[]): MediaItemInput[] {
  const bucket = s3Bucket?.trim()
  if (!bucket) {
    throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
  }
  return items.map((item) => ({
    ...item,
    s3Bucket: bucket,
  }))
}

function isSendCreated(
  result: SendMessageWithOutboxResult,
): result is Extract<SendMessageWithOutboxResult, { status: 'created' }> {
  return result.status === 'created'
}

/** Deterministic idempotency key — one auto-reply per TEXT_COINS trigger seq. */
export function buildAutoReplyClientMessageId(
  conversationId: string,
  triggerMessageSeq: number,
): string {
  return `auto-reply:${conversationId}:${triggerMessageSeq}`
}

function serializeMessageForHotCache(msg: MessageWithDetails): string {
  return JSON.stringify(
    { ...msg, createdAt: msg.createdAt.toISOString() },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  )
}

function trimMessageHotCacheRankEnd(): number {
  return -(MSG_HOT_CACHE_SIZE + 1)
}

async function warmMessageHotCache(
  conversationId: string,
  messages: MessageWithDetails[],
): Promise<void> {
  if (messages.length === 0) return
  const msgKey = RedisKeys.convMessages(conversationId)
  const pipeline = redisClient.pipeline()
  for (const msg of messages) {
    pipeline.zadd(msgKey, Number(msg.seq), serializeMessageForHotCache(msg))
  }
  pipeline.expire(msgKey, MSG_HOT_TTL)
  pipeline.zremrangebyrank(msgKey, 0, trimMessageHotCacheRankEnd())
  await pipeline.exec()
}

async function pushMessageToHotCache(conversationId: string, msg: MessageWithDetails): Promise<void> {
  const msgKey = RedisKeys.convMessages(conversationId)
  await redisClient.zadd(msgKey, Number(msg.seq), serializeMessageForHotCache(msg))
  await redisClient.expire(msgKey, MSG_HOT_TTL)
  await redisClient.zremrangebyrank(msgKey, 0, trimMessageHotCacheRankEnd())
}

function parseHotCacheMessages(raw: string[]): MessageWithDetails[] {
  const messages: MessageWithDetails[] = []
  for (let i = 0; i < raw.length; i += 2) {
    const json = raw[i]
    if (typeof json !== 'string') continue
    const parsed = JSON.parse(json) as MessageWithDetails & { createdAt: string }
    parsed.createdAt = new Date(parsed.createdAt) as any
    messages.push(parsed as MessageWithDetails)
  }
  return messages
}

async function applyNewMessageSideEffects(params: {
  conversationId: string
  msg: MessageWithDetails
  outboxId: bigint
  otherMemberIds: string[]
  senderId: string
}): Promise<void> {
  await pushMessageToHotCache(params.conversationId, params.msg)
  for (const uid of params.otherMemberIds) {
    if (uid === params.senderId) continue
    await redisClient.incr(RedisKeys.unreadCount(uid, params.conversationId))
  }
  await enqueueMessageOutboxPublish(params.outboxId)
  for (const mi of params.msg.mediaItems) {
    if (mi.mediaType === 'AUDIO' && mi.processingStatus === MediaProcessingStatus.ENQUEUED) {
      await enqueueMessageMediaAudioProcessing(mi.id)
    }
  }
}

async function markConversationReadOnView(
  userId: string,
  conversationId: string,
  messages: MessageWithDetails[],
): Promise<void> {
  await redisClient.set(RedisKeys.unreadCount(userId, conversationId), '0', 'EX', 86400)
  const latest = messages[0]
  if (!latest?.id) return
  try {
    const updated = await messageRepository.updateReadCursor(conversationId, userId, latest.id)
    if (updated) {
      await publishServerFrameToConversation(conversationId, {
        t: 'READ',
        conversationId,
        userId,
        lastReadMessageId: latest.id,
      })
    }
  } catch (err) {
    messagingLog.warn({ err, conversationId, userId }, 'markConversationReadOnView failed')
  }
}

export const messagingService = {
  async canUserMessage(
    senderId: string,
    recipientId: string,
    options?: CanUserMessageOptions,
  ): Promise<void> {
    if (await blockRepository.isBlocked(recipientId, senderId)) {
      // Evict any cached permission — block state wins regardless of TTL
      await redisClient.del(RedisKeys.allowedMessaging(recipientId, senderId)).catch(() => {})
      throw new AppError(403, 'User has blocked you', 'USER_BLOCKED')
    }
    if (await blockRepository.isBlocked(senderId, recipientId)) {
      throw new AppError(403, 'You have blocked this user', 'YOU_ARE_BLOCKED')
    }
    if (options?.bypassDmPrivacy) return

    const settings = await userSettingsService.getOrCreateSettings(recipientId)
    const allowAny =
      settings.allowMsgFromMutual || settings.allowMsgFromFollowing || settings.allowMsgFromStranger
    if (!allowAny) {
      throw new AppError(403, 'Messaging not allowed', 'MESSAGING_NOT_ALLOWED')
    }
    if (settings.allowMsgFromStranger) return

    const allowedCacheKey = RedisKeys.allowedMessaging(recipientId, senderId)
    const cachedAllowed = await redisClient.get(allowedCacheKey)
    if (cachedAllowed === '1') return

    // O(1) targeted existence checks — replaces fetching up to 500 IDs per call.
    // recipientFollowsSender: recipient follows sender → qualifies for allowMsgFromFollowing.
    // senderFollowsRecipient: both follow each other → qualifies for allowMsgFromMutual.
    const [recipientFollowsSender, senderFollowsRecipient] = await Promise.all([
      followRepository.existsFollow(recipientId, senderId),
      followRepository.existsFollow(senderId, recipientId),
    ])
    const isMutual = recipientFollowsSender && senderFollowsRecipient

    if (settings.allowMsgFromFollowing && recipientFollowsSender) {
      await redisClient.set(allowedCacheKey, '1', 'EX', 60)
      return
    }
    if (settings.allowMsgFromMutual && isMutual) {
      await redisClient.set(allowedCacheKey, '1', 'EX', 60)
      return
    }
    throw new AppError(403, 'Messaging not allowed', 'MESSAGING_NOT_ALLOWED')
  },

  async getOrCreateDirectConversation(
    initiatorId: string,
    recipientPublicId: string,
  ): Promise<{
    conversation: Awaited<ReturnType<typeof conversationRepository.createConversation>>
    isNew: boolean
  }> {
    const recipient = await userSearchService.searchByPublicId(recipientPublicId, initiatorId)
    if (!recipient) {
      throw new AppError(404, 'User not found', 'NOT_FOUND')
    }
    const recipientId = recipient.userId
    await this.canUserMessage(initiatorId, recipientId, {
      bypassDmPrivacy: recipient.isAgency,
    })

    const existing = await conversationRepository.findDirectConversation(initiatorId, recipientId)
    if (existing) {
      const withMembers = await conversationRepository.findConversationById(
        existing.id,
        initiatorId,
      )
      if (!withMembers) throw new AppError(403, 'Forbidden', 'FORBIDDEN')
      return { conversation: withMembers as any, isNew: false }
    }

    const conversation = await conversationRepository.createConversation({
      type: 'DIRECT',
      memberIds: [initiatorId, recipientId],
    })
    await cacheService.delete(RedisKeys.userConversations(initiatorId))
    await cacheService.delete(RedisKeys.userConversations(recipientId))
    return { conversation, isNew: true }
  },

  async sendMessage(
    senderId: string,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<MessageWithDetails> {
    const conv = await conversationRepository.findConversationById(conversationId, senderId)
    if (!conv) {
      throw new AppError(403, 'Not a member', 'FORBIDDEN')
    }
    const otherMemberIds = conv.members.filter((m) => m.userId !== senderId).map((m) => m.userId)
    const bypassDmPrivacy = await shouldBypassDmPrivacyForSend({
      messageType: input.type,
      senderId,
      conversationId,
    })
    for (const otherId of otherMemberIds) {
      await this.canUserMessage(senderId, otherId, { bypassDmPrivacy })
    }
    if (input.replyToId) {
      const replyTo = await messageRepository.findMessageById(input.replyToId)
      if (!replyTo || replyTo.conversationId !== conversationId) {
        throw new AppError(400, 'Invalid reply target', 'INVALID_REPLY')
      }
    }
    assertMessageTypeMediaAlignment(input.type as any, input.mediaItems)

    let mediaItemsPrepared: MediaItemInput[] | undefined
    if (input.mediaItems && input.mediaItems.length > 0) {
      mediaItemsPrepared = await prepareMediaItemsForSend({
        senderId,
        conversationId,
        messageType: input.type as any,
        items: input.mediaItems,
      })
      mediaItemsPrepared = mediaItemsWithServerBucket(mediaItemsPrepared)
    }

    const result = await messageRepository.sendMessageWithOutbox({
      conversationId,
      senderId,
      clientMessageId: input.clientMessageId,
      type: input.type as any,
      content: input.content,
      replyToId: input.replyToId,
      mediaItems: mediaItemsPrepared,
    })
    const msg = result.message

    await Promise.all(
      conv.members.map((m: { userId: string }) =>
        cacheService.delete(RedisKeys.userConversations(m.userId)),
      ),
    )

    if (isSendCreated(result)) {
      await applyNewMessageSideEffects({
        conversationId,
        msg,
        outboxId: result.outboxId,
        otherMemberIds,
        senderId,
      })
    }

    // Auto-reply on every TEXT_COINS send attempt (including idempotent retries with
    // status `duplicate`) so a retried clientMessageId still triggers the worker.
    if (input.type === 'TEXT_COINS') {
      setImmediate(() => {
        void maybeEnqueueAutoReply(conversationId, msg.seq).catch((err) => {
          messagingLog.warn({ err, conversationId }, 'TEXT_COINS auto-reply enqueue failed')
        })
      })
    }

    return msg
  },

  async sendAutoReply(params: {
    conversationId: string
    senderUserId: string
    content: string
    clientMessageId: string
  }): Promise<void> {
    const { conversationId, senderUserId, content, clientMessageId } = params

    const member = await prismaRead.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: senderUserId } },
    })
    if (!member) {
      messagingLog.warn({ conversationId, senderUserId }, 'auto-reply aborted: sender not a member')
      return
    }

    const conv = await conversationRepository.findConversationById(conversationId, senderUserId)
    if (!conv) return

    const otherMemberIds = conv.members
      .filter((m) => m.userId !== senderUserId)
      .map((m) => m.userId)

    const result = await messageRepository.sendMessageWithOutbox({
      conversationId,
      senderId: senderUserId,
      type: 'TEXT',
      content,
      clientMessageId,
      mediaItems: [],
      isAutoReply: true,
    })

    if (!isSendCreated(result)) return

    await Promise.all(
      conv.members.map((m: { userId: string }) =>
        cacheService.delete(RedisKeys.userConversations(m.userId)),
      ),
    )

    await applyNewMessageSideEffects({
      conversationId,
      msg: result.message,
      outboxId: result.outboxId,
      otherMemberIds,
      senderId: senderUserId,
    })
  },

  async listMessages(
    userId: string,
    conversationId: string,
    cursor?: string,
    limit = 30,
  ): Promise<PaginatedMessages> {
    const conv = await conversationRepository.findConversationById(conversationId, userId)
    if (!conv) {
      throw new AppError(403, 'Not a member', 'FORBIDDEN')
    }
    const selfMember = conv.members.find((m) => m.userId === userId)
    const historyClearedAfter = selfMember?.deletedAt ?? null

    if (!cursor && !historyClearedAfter) {
      const raw = await redisClient.zrevrange(
        RedisKeys.convMessages(conversationId),
        0,
        limit - 1,
        'WITHSCORES',
      )
      const cachedCount = raw.length / 2
      if (cachedCount >= limit) {
        const messages = parseHotCacheMessages(raw)
        const nextCursor =
          messages.length > 0
            ? ((messages[messages.length - 1]?.createdAt as Date)?.toISOString() ?? null)
            : null
        await markConversationReadOnView(userId, conversationId, messages)
        return { messages, nextCursor }
      }
    }

    const warmLimit = !cursor && !historyClearedAfter ? Math.max(limit, MSG_HOT_CACHE_SIZE) : limit
    const result = await messageRepository.listMessages(
      conversationId,
      userId,
      cursor,
      warmLimit,
    )

    if (!cursor && !historyClearedAfter && result.messages.length > 0) {
      await warmMessageHotCache(conversationId, result.messages)
    }

    if (!cursor && !historyClearedAfter && result.messages.length > limit) {
      const page = result.messages.slice(0, limit)
      const hasMore = result.messages.length > limit || result.nextCursor !== null
      await markConversationReadOnView(userId, conversationId, page)
      return {
        messages: page,
        nextCursor: hasMore
          ? ((page[page.length - 1]?.createdAt as Date)?.toISOString() ?? null)
          : null,
      }
    }

    await markConversationReadOnView(userId, conversationId, result.messages)
    return result
  },

  async listConversations(
    userId: string,
    cursor?: string,
    limit = 20,
  ): Promise<PaginatedConversations> {
    if (!cursor) {
      const cached = await redisClient.get(RedisKeys.userConversations(userId))
      if (cached) {
        return JSON.parse(cached) as PaginatedConversations
      }
    }
    const result = await conversationRepository.listConversationsForUser(userId, cursor, limit)
    const unreadKeys = result.conversations.map((c) => RedisKeys.unreadCount(userId, c.id))
    const unreadValues = unreadKeys.length ? await redisClient.mget(...unreadKeys) : []
    type ConvPreview = (typeof result.conversations)[number]
    const unreadCounts = new Map(
      result.conversations.map((c: ConvPreview, i: number) => [
        c.id,
        unreadValues[i] ? parseInt(String(unreadValues[i]), 10) : null,
      ]),
    )
    for (const conv of result.conversations) {
      const cached = unreadCounts.get(conv.id)
      if (cached === null || cached === undefined) {
        const count = await messageRepository.getUnreadCount(conv.id, userId)
        unreadCounts.set(conv.id, count)
        await redisClient.set(RedisKeys.unreadCount(userId, conv.id), String(count), 'EX', 86400)
      }
    }
    const withUnread = result.conversations.map((c: ConvPreview) => ({
      ...c,
      unreadCount: unreadCounts.get(c.id) ?? 0,
    }))
    const payload: PaginatedConversations = {
      conversations: withUnread as any,
      nextCursor: result.nextCursor,
    }
    if (!cursor) {
      await redisClient.set(
        RedisKeys.userConversations(userId),
        JSON.stringify(payload),
        'EX',
        CONV_LIST_TTL,
      )
    }
    return payload
  },

  async clearChatHistory(userId: string, conversationId: string): Promise<void> {
    const conv = await conversationRepository.findConversationById(conversationId, userId)
    if (!conv) {
      throw new AppError(403, 'Not a member', 'FORBIDDEN')
    }
    await conversationRepository.markConversationDeleted(conversationId, userId)
    await cacheService.delete(RedisKeys.userConversations(userId))
    await redisClient.del(RedisKeys.convMessages(conversationId))
    await auditService.log({
      actionType: 'CLEAR_CHAT',
      actionStatus: 'success',
      userId,
      actionDetails: { conversationId },
    })
  },

  async muteConversation(
    userId: string,
    conversationId: string,
    mutedUntil?: string | null,
  ): Promise<void> {
    const conv = await conversationRepository.findConversationById(conversationId, userId)
    if (!conv) {
      throw new AppError(403, 'Not a member', 'FORBIDDEN')
    }
    const isMuted = mutedUntil !== null
    await conversationRepository.updateMuteStatus(
      conversationId,
      userId,
      isMuted,
      mutedUntil ? new Date(mutedUntil) : null,
    )
    await publishToConversation(conversationId, {
      type: 'CONV_MUTED',
      conversationId,
      userId,
      mutedUntil: mutedUntil ?? null,
    })
  },

  async addReaction(userId: string, messageId: string, emoji: string): Promise<void> {
    const msg = await messageRepository.findMessageById(messageId)
    if (!msg) {
      throw new AppError(404, 'Message not found', 'NOT_FOUND')
    }
    await messageRepository.upsertReaction(messageId, userId, emoji)
    await cacheService.delete(RedisKeys.convMessages(msg.conversationId))
    await publishToConversation(msg.conversationId, {
      type: 'REACTION_ADDED',
      conversationId: msg.conversationId,
      messageId,
      userId,
      emoji,
    })
  },

  async removeReaction(userId: string, messageId: string, emoji: string): Promise<void> {
    const msg = await messageRepository.findMessageById(messageId)
    if (!msg) {
      throw new AppError(404, 'Message not found', 'NOT_FOUND')
    }
    await messageRepository.removeReaction(messageId, userId, emoji)
    await cacheService.delete(RedisKeys.convMessages(msg.conversationId))
    await publishToConversation(msg.conversationId, {
      type: 'REACTION_REMOVED',
      conversationId: msg.conversationId,
      messageId,
      userId,
      emoji,
    })
  },

  async deleteMessage(userId: string, messageId: string): Promise<void> {
    const msg = await messageRepository.softDeleteMessage(messageId, userId)
    await cacheService.delete(RedisKeys.convMessages(msg.conversationId))
    await redisClient.del(RedisKeys.convMessages(msg.conversationId))
    await publishToConversation(msg.conversationId, {
      type: 'MESSAGE_DELETED',
      conversationId: msg.conversationId,
      messageId,
    })
  },

  async getDmContacts(userId: string): Promise<DmContact[]> {
    const cacheKey = `dm-contacts:${userId}`
    const cached = await redisClient.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as DmContact[]
    }
    const { items: friends } = await followService.getFriends(userId, userId, null, 40)
    let contactIds = friends.map((c: { userId: string }) => c.userId)
    let following: {
      userId: string
      username: string
      name?: string
      displayName: string
      publicId: string
      displayPublicId: string
      avatarUrl: string | null
    }[] = []
    if (contactIds.length < 40) {
      const res = await followService.getFollowing(userId, userId, null, 40)
      following = res.items.map((c) => ({
        userId: c.userId,
        username: c.username,
        name: c.name,
        displayName: c.displayName,
        publicId: c.publicId,
        displayPublicId: c.displayPublicId,
        avatarUrl: c.avatarUrl,
      }))
      const set = new Set(contactIds)
      for (const c of following as Array<{ userId: string }>) {
        if (set.size >= 40) break
        set.add(c.userId)
      }
      contactIds = Array.from(set).slice(0, 40)
    }
    const existingConvs = await Promise.all(
      contactIds.map((id: string) => conversationRepository.findDirectConversation(userId, id)),
    )
    const onlineKeys = contactIds.map((id: string) => RedisKeys.userOnlineStatus(id))
    const onlineValues = onlineKeys.length ? await redisClient.mget(...onlineKeys) : []
    const effOnline = await privacyService.getEffectiveFlagsBulk(contactIds)
    const result: DmContact[] = contactIds.map((id: string, i: number) => {
      const friendCard = friends.find((f: { userId: string }) => f.userId === id)
      const followCard = following.find((f: { userId: string }) => f.userId === id)
      const card = friendCard ?? followCard
      return {
        userId: id,
        username: card?.username ?? '',
        name: card?.name ?? card?.displayName ?? '',
        publicId: card?.publicId ?? '',
        displayPublicId: card?.displayPublicId ?? card?.publicId ?? '',
        avatar: card?.avatarUrl ?? null,
        isOnline: !!onlineValues[i] && !(effOnline.get(id)?.invisibleOnline ?? false),
        isMutual: !!friendCard,
        existingConversationId: existingConvs[i]?.id ?? null,
      }
    })
    await redisClient.set(cacheKey, JSON.stringify(result), 'EX', 60)
    return result
  },

  /** After JOIN verified — warms conv membership cache for typing (60s). */
  async touchConvMemberCache(userId: string, conversationId: string): Promise<void> {
    await redisClient.set(
      RedisKeys.convMember(conversationId, userId),
      '1',
      'EX',
      CONV_MEMBER_CACHE_TTL_SEC,
    )
  },

  async ensureConvMemberForTyping(userId: string, conversationId: string): Promise<boolean> {
    const key = RedisKeys.convMember(conversationId, userId)
    const hit = await redisClient.get(key)
    if (hit === '1') return true
    const conv = await conversationRepository.findConversationById(conversationId, userId)
    if (!conv) return false
    await redisClient.set(key, '1', 'EX', CONV_MEMBER_CACHE_TTL_SEC)
    return true
  },

  async handleTypingFrame(
    userId: string,
    conversationId: string,
    isTyping: boolean,
  ): Promise<void> {
    const ok = await this.ensureConvMemberForTyping(userId, conversationId)
    if (!ok) return

    const throttleKey = RedisKeys.typingThrottle(conversationId, userId)
    const firstInWindow = await redisClient.set(
      throttleKey,
      '1',
      'EX',
      TYPING_THROTTLE_TTL_SEC,
      'NX',
    )
    if (firstInWindow === null) return

    if (isTyping) {
      await redisClient.set(
        RedisKeys.userTyping(conversationId, userId),
        '1',
        'EX',
        TYPING_INDICATOR_TTL_SEC,
      )
    } else {
      await redisClient.del(RedisKeys.userTyping(conversationId, userId))
    }

    await publishServerFrameToConversation(conversationId, {
      t: 'TYPING',
      conversationId,
      userId,
      isTyping,
    })
  },

  scheduleReadReceipt(userId: string, conversationId: string, lastReadMessageId: string): void {
    const key = readReceiptDebounceKey(userId, conversationId)
    const existing = readReceiptDebounce.get(key)
    if (existing) {
      clearTimeout(existing.timer)
    }
    const timer = setTimeout(() => {
      const pending = readReceiptDebounce.get(key)
      readReceiptDebounce.delete(key)
      if (!pending) return
      void messagingService.flushReadReceipt(userId, conversationId, pending.lastReadMessageId)
    }, READ_RECEIPT_DEBOUNCE_MS)
    readReceiptDebounce.set(key, { timer, lastReadMessageId })
  },

  async flushReadReceipt(
    userId: string,
    conversationId: string,
    lastReadMessageId: string,
  ): Promise<void> {
    try {
      const updated = await messageRepository.updateReadCursor(
        conversationId,
        userId,
        lastReadMessageId,
      )
      if (!updated) return
      await redisClient.set(RedisKeys.unreadCount(userId, conversationId), '0', 'EX', 86400)
      await publishServerFrameToConversation(conversationId, {
        t: 'READ',
        conversationId,
        userId,
        lastReadMessageId,
      })
    } catch (e) {
      console.warn('[messaging] flushReadReceipt failed', e)
    }
  },

  /** Phase 5: membership-checked lastSeq + gap hint for reconnect sync. */
  async getResumeSyncStates(
    userId: string,
    items: { conversationId: string; afterSeq?: number }[],
  ): Promise<Array<{ conversationId: string; latestSeq: number; hasGap: boolean }>> {
    const out: Array<{ conversationId: string; latestSeq: number; hasGap: boolean }> = []
    for (const it of items) {
      const member = await conversationRepository.isActiveConversationMember(
        it.conversationId,
        userId,
      )
      if (!member) continue
      const lastSeq = await conversationRepository.getConversationLastSeq(it.conversationId)
      if (lastSeq === null) continue
      const latestSeq = Number(lastSeq)
      const hasGap =
        it.afterSeq !== undefined && Number.isFinite(it.afterSeq) && it.afterSeq < latestSeq
      out.push({ conversationId: it.conversationId, latestSeq, hasGap })
    }
    return out
  },
}
