import { superAdminNotificationRepository } from '../repositories/superAdminNotification.repository'
import { systemAdminRepository } from '../repositories/systemAdmin.repository'
import { formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import type { ModerationNotificationType } from '@prisma/client'

export const superAdminNotificationService = {
  /**
   * Fan out to every active SUPER_ADMIN. Fire-and-forget safe: notification
   * failures must never break the moderation action that triggered them.
   * Mirrors `csaNotificationService.notify`.
   */
  async notifyAll(
    actionType: ModerationNotificationType,
    data: {
      targetUserId: string
      reason?: string | null
      restrictedUntil?: Date | null
      performedByAdminId: string
    },
  ): Promise<void> {
    try {
      const superAdmins = await systemAdminRepository.findAllByRole('SUPER_ADMIN', 'ACTIVE')
      if (superAdmins.length === 0) return
      await superAdminNotificationRepository.createForRecipients(
        superAdmins.map((a) => a.id),
        { actionType, ...data },
      )
    } catch (err) {
      console.error('[super-admin-notification] create failed', { actionType, err })
    }
  },

  async list(adminId: string, query: { unreadOnly?: boolean; page: number; limit: number }) {
    const { items, total } = await superAdminNotificationRepository.findByAdmin(adminId, {
      unreadOnly: query.unreadOnly,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    })
    return {
      notifications: items.map((n) => ({
        id: n.id,
        actionType: n.actionType,
        reason: n.reason,
        restrictedUntil: n.restrictedUntil?.toISOString() ?? null,
        performedByAdminId: n.performedByAdminId,
        isRead: n.isRead,
        readAt: n.readAt,
        createdAt: n.createdAt,
        targetUser: {
          userId: n.targetUser.id,
          username: n.targetUser.username,
          name: formatUserName(n.targetUser),
          publicId: String(n.targetUser.publicId),
          displayPublicId: resolveDisplayPublicId(n.targetUser),
        },
      })),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    }
  },

  async badge(adminId: string) {
    const unreadCount = await superAdminNotificationRepository.countUnread(adminId)
    return { unreadCount }
  },

  async markRead(adminId: string, ids?: string[]) {
    if (ids && ids.length > 0) {
      const res = await superAdminNotificationRepository.markRead(adminId, ids)
      return { marked: res.count }
    }
    const res = await superAdminNotificationRepository.markAllRead(adminId)
    return { marked: res.count }
  },
}
