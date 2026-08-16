import { randomUUID } from 'crypto'
import { userRepository } from '../repositories/user.repository'
import { AppError } from '../middlewares/errorHandler'
import { auditService } from './audit.service'
import { platformMessagingService } from './platformMessaging.service'
import { enqueuePlatformNotificationBroadcast } from '../queues/platform-message.queue'
import type {
  PlatformMessageMetadata,
  PlatformPostRefSnapshot,
} from '../models/platform-message.schemas'

const DEFAULT_WARNING =
  'Your account has received a warning from platform moderation. Please review our community guidelines.'

function toPostRefSnapshot(post: {
  id: string
  caption: string | null
  createdAt: Date | string
  mediaUrl: string
  thumbnailUrl?: string | null
  mediaType?: 'IMAGE' | 'VIDEO'
}): PlatformPostRefSnapshot {
  return {
    id: post.id,
    caption: post.caption,
    createdAt:
      typeof post.createdAt === 'string' ? post.createdAt : post.createdAt.toISOString(),
    mediaUrl: post.mediaUrl,
    thumbnailUrl: post.thumbnailUrl ?? null,
    ...(post.mediaType ? { mediaType: post.mediaType } : {}),
  }
}

export const adminMessagingService = {
  async sendSystemMessage(params: {
    targetUserId: string
    adminUserId: string
    message: string
    auditActionType?: string
    /** Merged into SYSTEM message metadata (e.g. post snapshot for moderation warnings). */
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

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: params.targetUserId,
      actionType: params.auditActionType ?? 'ADMIN_SYSTEM_MESSAGE',
      actionStatus: 'success',
      actionDetails: {
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
      ...(params.metadataExtras?.post ? { post: params.metadataExtras.post } : {}),
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

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: params.targetUserId,
      actionType: 'ADMIN_NOTIFICATION_MESSAGE',
      actionStatus: 'success',
      actionDetails: {
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

  /**
   * Post-moderation warning via SYSTEM inbox.
   * When `post` is provided, metadata stores a durable snapshot (id, caption, createdAt, media)
   * plus `postId` / `refType: "post"` for deep-link.
   */
  async sendPlatformWarning(params: {
    targetUserId: string
    adminUserId: string
    message?: string
    /** @deprecated Prefer `post` snapshot; kept for callers that only know the id. */
    postId?: string
    post?: {
      id: string
      caption: string | null
      createdAt: Date | string
      mediaUrl: string
      thumbnailUrl?: string | null
      mediaType?: 'IMAGE' | 'VIDEO'
    }
  }) {
    const content = (params.message?.trim() || DEFAULT_WARNING).slice(0, 4000)
    const postSnap = params.post ? toPostRefSnapshot(params.post) : undefined
    const postId = postSnap?.id ?? params.postId

    return this.sendSystemMessage({
      targetUserId: params.targetUserId,
      adminUserId: params.adminUserId,
      message: content,
      auditActionType: 'ADMIN_USER_WARNING',
      metadataExtras: postId
        ? {
            postId,
            refType: 'post' as const,
            ...(postSnap ? { post: postSnap } : {}),
          }
        : undefined,
      auditDetails: postId ? { postId } : undefined,
    })
  },
}
