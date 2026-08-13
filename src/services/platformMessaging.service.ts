import type { MessageType } from '@prisma/client'
import {
  messageRepository,
  type MessageWithDetails,
} from '../repositories/message.repository'
import { userRepository } from '../repositories/user.repository'
import { cacheService } from './cache.service'
import { RedisKeys, redisClient, MSG_HOT_CACHE_SIZE } from '../config/redis'
import { enqueueMessageOutboxPublish } from '../queues/messaging.queue'
import { publishMessageOutboxRow } from './messaging-outbox.service'
import type { PlatformMessageMetadata } from '../models/platform-message.schemas'
import { messageTypeToPlatformConversationType } from '../lib/platform-conversations.constants'
import { platformConversationsService } from './platformConversations.service'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'platform-messaging' })

const MSG_HOT_TTL = 86400

function serializeMessageForHotCache(msg: MessageWithDetails): string {
  return JSON.stringify({ ...msg, createdAt: msg.createdAt.toISOString() }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

async function pushMessageToHotCache(conversationId: string, msg: MessageWithDetails): Promise<void> {
  const msgKey = RedisKeys.convMessages(conversationId)
  await redisClient.zadd(msgKey, Number(msg.seq), serializeMessageForHotCache(msg))
  await redisClient.expire(msgKey, MSG_HOT_TTL)
  await redisClient.zremrangebyrank(msgKey, 0, -(MSG_HOT_CACHE_SIZE + 1))
}

async function applyPlatformMessageSideEffects(params: {
  conversationId: string
  msg: MessageWithDetails
  outboxId: bigint
  targetUserId: string
  platformSenderUserId: string
}): Promise<void> {
  await pushMessageToHotCache(params.conversationId, params.msg)
  await redisClient.incr(RedisKeys.unreadCount(params.targetUserId, params.conversationId))
  try {
    await publishMessageOutboxRow(params.outboxId)
  } catch (err) {
    log.warn({ err, outboxId: params.outboxId.toString() }, 'inline platform outbox publish failed')
    await enqueueMessageOutboxPublish(params.outboxId)
  }
}

export const platformMessagingService = {
  async sendPlatformMessage(params: {
    targetUserId: string
    type: Extract<MessageType, 'SYSTEM' | 'NOTIFICATION' | 'TRANSACTIONAL'>
    content: string
    metadata?: PlatformMessageMetadata
    clientMessageId: string
  }): Promise<{ conversationId: string; messageId: string; created: boolean }> {
    const target = await userRepository.findById(params.targetUserId)
    if (!target) {
      log.warn({ targetUserId: params.targetUserId }, 'platform message skipped: user missing')
      return { conversationId: '', messageId: '', created: false }
    }

    const conversationType = messageTypeToPlatformConversationType(params.type)
    const { conversationId, platformSenderUserId } =
      await platformConversationsService.resolveForMessage(params.targetUserId, conversationType)

    const result = await messageRepository.sendMessageWithOutbox({
      conversationId,
      senderId: platformSenderUserId,
      clientMessageId: params.clientMessageId,
      type: params.type,
      content: params.content.slice(0, 4000),
      metadata: params.metadata,
    })

    await Promise.all([
      cacheService.delete(RedisKeys.userConversations(platformSenderUserId)),
      cacheService.delete(RedisKeys.userConversations(params.targetUserId)),
      cacheService.delete(RedisKeys.convMessages(conversationId)),
    ])

    if (result.status === 'created') {
      await applyPlatformMessageSideEffects({
        conversationId,
        msg: result.message,
        outboxId: result.outboxId,
        targetUserId: params.targetUserId,
        platformSenderUserId,
      })
    }

    return {
      conversationId,
      messageId: result.message.id,
      created: result.status === 'created',
    }
  },
}
