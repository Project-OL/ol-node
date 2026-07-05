import { randomUUID } from 'crypto'
import { userRepository } from '../repositories/user.repository'
import { AppError } from '../middlewares/errorHandler'
import { auditService } from './audit.service'
import { platformMessagingService } from './platformMessaging.service'
import { enqueuePlatformNotificationBroadcast } from '../queues/platform-message.queue'
import type { PlatformMessageMetadata } from '../models/platform-message.schemas'

const DEFAULT_WARNING =
  'Your account has received a warning from platform moderation. Please review our community guidelines.'

export const adminMessagingService = {
  async sendSystemMessage(params: {
    targetUserId: string
    adminUserId: string
    message: string
    auditActionType?: string
  }) {
    const target = await userRepository.findById(params.targetUserId)
    if (!target) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const content = params.message.trim().slice(0, 4000)
    const metadata: PlatformMessageMetadata = {
      category: 'system',
      adminUserId: params.adminUserId,
    }

    const clientMessageId = `admin-system:${params.adminUserId}:${randomUUID()}`
    const result = await platformMessagingService.sendPlatformMessage({
      targetUserId: params.targetUserId,
      type: 'SYSTEM',
      content,
      metadata,
      clientMessageId,
    })

    auditService.log({
      userId: params.adminUserId,
      actionType: params.auditActionType ?? 'ADMIN_SYSTEM_MESSAGE',
      actionStatus: 'success',
      actionDetails: {
        targetUserId: params.targetUserId,
        conversationId: result.conversationId,
        messageId: result.messageId,
      },
    })

    return {
      ok: true as const,
      conversationId: result.conversationId,
      messageId: result.messageId,
      content,
    }
  },

  async sendNotificationMessage(params: {
    targetUserId: string
    adminUserId: string
    message: string
    campaignId?: string
  }) {
    const target = await userRepository.findById(params.targetUserId)
    if (!target) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const content = params.message.trim().slice(0, 4000)
    const campaignId = params.campaignId ?? `admin:${params.adminUserId}:${randomUUID()}`
    const metadata: PlatformMessageMetadata = {
      category: 'notification',
      campaignId,
      adminUserId: params.adminUserId,
    }

    const result = await platformMessagingService.sendPlatformMessage({
      targetUserId: params.targetUserId,
      type: 'NOTIFICATION',
      content,
      metadata,
      clientMessageId: `notify:${campaignId}:${params.targetUserId}`,
    })

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_NOTIFICATION_MESSAGE',
      actionStatus: 'success',
      actionDetails: {
        targetUserId: params.targetUserId,
        campaignId,
        conversationId: result.conversationId,
        messageId: result.messageId,
      },
    })

    return {
      ok: true as const,
      conversationId: result.conversationId,
      messageId: result.messageId,
      campaignId,
      content,
    }
  },

  async broadcastNotificationMessage(params: {
    adminUserId: string
    message: string
    userIds?: string[]
    campaignId?: string
  }) {
    await enqueuePlatformNotificationBroadcast(params)
    return {
      ok: true as const,
      queued: true as const,
      campaignId: params.campaignId ?? null,
    }
  },

  /** @deprecated Use sendSystemMessage — kept for post moderation warnings. */
  async sendPlatformWarning(params: {
    targetUserId: string
    adminUserId: string
    message?: string
    postId?: string
  }) {
    const content = (params.message?.trim() || DEFAULT_WARNING).slice(0, 4000)
    const result = await this.sendSystemMessage({
      targetUserId: params.targetUserId,
      adminUserId: params.adminUserId,
      message: content,
      auditActionType: 'ADMIN_USER_WARNING',
    })

    if (params.postId) {
      auditService.log({
        userId: params.adminUserId,
        actionType: 'ADMIN_USER_WARNING',
        actionStatus: 'success',
        actionDetails: {
          targetUserId: params.targetUserId,
          postId: params.postId,
          conversationId: result.conversationId,
          messageId: result.messageId,
        },
      })
    }

    return result
  },
}
