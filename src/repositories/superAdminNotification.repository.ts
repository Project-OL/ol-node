import { prisma, prismaRead } from '../config/database'
import type { ModerationNotificationType } from '@prisma/client'

export const superAdminNotificationRepository = {
  async createForRecipients(
    recipientAdminIds: string[],
    data: {
      actionType: ModerationNotificationType
      targetUserId: string
      reason?: string | null
      restrictedUntil?: Date | null
      performedByAdminId: string
    },
  ) {
    if (recipientAdminIds.length === 0) return
    await prisma.superAdminNotification.createMany({
      data: recipientAdminIds.map((recipientAdminId) => ({
        recipientAdminId,
        actionType: data.actionType,
        targetUserId: data.targetUserId,
        reason: data.reason ?? null,
        restrictedUntil: data.restrictedUntil ?? null,
        performedByAdminId: data.performedByAdminId,
      })),
    })
  },

  async findByAdmin(adminId: string, opts: { unreadOnly?: boolean; skip: number; take: number }) {
    const where = { recipientAdminId: adminId, ...(opts.unreadOnly ? { isRead: false } : {}) }
    const [items, total] = await Promise.all([
      prismaRead.superAdminNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          targetUser: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              publicId: true,
              defaultPublicId: true,
              currentVipPublicId: true,
            },
          },
        },
      }),
      prismaRead.superAdminNotification.count({ where }),
    ])
    return { items, total }
  },

  async countUnread(adminId: string) {
    return prismaRead.superAdminNotification.count({
      where: { recipientAdminId: adminId, isRead: false },
    })
  },

  async markRead(adminId: string, ids: string[]) {
    return prisma.superAdminNotification.updateMany({
      where: { recipientAdminId: adminId, id: { in: ids }, isRead: false },
      data: { isRead: true, readAt: new Date() },
    })
  },

  async markAllRead(adminId: string) {
    return prisma.superAdminNotification.updateMany({
      where: { recipientAdminId: adminId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    })
  },
}
