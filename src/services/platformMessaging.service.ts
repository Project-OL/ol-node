import type { MessageType } from '@prisma/client'
import { conversationRepository } from '../repositories/conversation.repository'
import {
  messageRepository,
  type MessageWithDetails,
} from '../repositories/message.repository'
import { userRepository } from '../repositories/user.repository'
import { cacheService } from './cache.service'
import { RedisKeys, redisClient } from '../config/redis'
import { enqueueMessageOutboxPublish } from '../queues/messaging.queue'
import type { PlatformMessageMetadata } from '../models/platform-message.schemas'
import { getOrCreatePlatformSenderUser } from './platformSender.service'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'platform-messaging' })

const MSG_HOT_TTL = 86400
const MSG_HOT_CACHE_SIZE = 200

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
  supportUserId: string
}): Promise<void> {
  await pushMessageToHotCache(params.conversationId, params.msg)
  await redisClient.incr(RedisKeys.unreadCount(params.targetUserId, params.conversationId))
  await enqueueMessageOutboxPublish(params.outboxId)
}

export const platformMessagingService = {
  async getOrCreatePlatformConversation(targetUserId: string): Promise<{
    conversationId: string
    platformSenderUserId: string
  }> {
    const sender = await getOrCreatePlatformSenderUser()

    const existing = await conversationRepository.findDirectConversation(sender.id, targetUserId)
    if (existing) {
      return { conversationId: existing.id, platformSenderUserId: sender.id }
    }

    const created = await conversationRepository.createConversation({
      type: 'DIRECT',
      memberIds: [sender.id, targetUserId],
    })
    return { conversationId: created.id, platformSenderUserId: sender.id }
  },

  /** @deprecated Use getOrCreatePlatformConversation */
  async getOrCreateSupportConversation(targetUserId: string) {
    const r = await this.getOrCreatePlatformConversation(targetUserId)
    return { conversationId: r.conversationId, supportUserId: r.platformSenderUserId }
  },

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

    const { conversationId, platformSenderUserId } = await this.getOrCreatePlatformConversation(
      params.targetUserId,
    )

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
        supportUserId: platformSenderUserId,
      })
    }

    return {
      conversationId,
      messageId: result.message.id,
      created: result.status === 'created',
    }
  },
}
