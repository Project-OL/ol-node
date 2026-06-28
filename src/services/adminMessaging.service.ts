import { randomUUID } from 'crypto'
import { conversationRepository } from '../repositories/conversation.repository'
import { messageRepository } from '../repositories/message.repository'
import { userRepository } from '../repositories/user.repository'
import { AppError } from '../middlewares/errorHandler'
import { cacheService } from './cache.service'
import { RedisKeys } from '../config/redis'
import { auditService } from './audit.service'

const DEFAULT_WARNING =
  'Your account has received a warning from platform moderation. Please review our community guidelines.'

export const adminMessagingService = {
  async sendSystemMessage(params: {
    targetUserId: string
    adminUserId: string
    message: string
    auditActionType?: string
  }) {
    return adminMessagingService.sendPlatformWarning({
      targetUserId: params.targetUserId,
      adminUserId: params.adminUserId,
      message: params.message,
    })
  },

  async sendPlatformWarning(params: {
    targetUserId: string
    adminUserId: string
    message?: string
    postId?: string
  }) {
    const target = await userRepository.findById(params.targetUserId)
    if (!target) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const support = await userRepository.findFirstSupportUser()
    if (!support) {
      throw new AppError(503, 'No support system user configured', 'SUPPORT_USER_MISSING')
    }

    const content = (params.message?.trim() || DEFAULT_WARNING).slice(0, 4000)

    let conversationId: string
    const existing = await conversationRepository.findDirectConversation(
      support.id,
      params.targetUserId,
    )
    if (existing) {
      conversationId = existing.id
    } else {
      const created = await conversationRepository.createConversation({
        type: 'DIRECT',
        memberIds: [support.id, params.targetUserId],
      })
      conversationId = created.id
    }

    const clientMessageId = `admin-warn:${params.adminUserId}:${randomUUID()}`
    const result = await messageRepository.sendMessageWithOutbox({
      conversationId,
      senderId: support.id,
      clientMessageId,
      type: 'SYSTEM',
      content,
    })

    await Promise.all([
      cacheService.delete(RedisKeys.userConversations(support.id)),
      cacheService.delete(RedisKeys.userConversations(params.targetUserId)),
    ])

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_USER_WARNING',
      actionStatus: 'success',
      actionDetails: {
        targetUserId: params.targetUserId,
        conversationId,
        messageId: result.message.id,
        postId: params.postId ?? null,
      },
    })

    return {
      ok: true as const,
      conversationId,
      messageId: result.message.id,
      content,
    }
  },
}
