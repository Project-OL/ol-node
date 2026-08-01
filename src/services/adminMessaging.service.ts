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
    /** Merged into SYSTEM message metadata (e.g. postId for moderation warnings). */
    metadataExtras?: Omit<PlatformMessageMetadata, 'category' | 'adminUserId'>
    /** Extra fields merged into the audit `actionDetails` payload. */
    auditDetails?: Record<string, unknown>
  }) {
    const target = await userRepository.findById(params.targetUserId)
    if (!target) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const content = params.message.trim().slice(0, 4000)
    const metadata: PlatformMessageMetadata = {
      category: 'system',
      adminUserId: params.adminUserId,
      ...params.metadataExtras,
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
        ...params.auditDetails,
      },
    })

    return {
      ok: true as const,
      conversationId: result.conversationId,
      messageId: result.messageId,
      content,
      ...(params.metadataExtras?.postId ? { postId: params.metadataExtras.postId } : {}),
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

  /** Post-moderation warning via SYSTEM inbox; optional `postId` is stored on message metadata. */
  async sendPlatformWarning(params: {
    targetUserId: string
    adminUserId: string
    message?: string
    postId?: string
  }) {
    const content = (params.message?.trim() || DEFAULT_WARNING).slice(0, 4000)
    return this.sendSystemMessage({
      targetUserId: params.targetUserId,
      adminUserId: params.adminUserId,
      message: content,
      auditActionType: 'ADMIN_USER_WARNING',
      metadataExtras: params.postId
        ? { postId: params.postId, refType: 'post' as const }
        : undefined,
      auditDetails: params.postId ? { postId: params.postId } : undefined,
    })
  },
}
