import { prisma, prismaRead } from '../config/database'
import type { CsaNotificationType } from '@prisma/client'

export const csaNotificationRepository = {
  async create(data: {
    adminId: string
    type: CsaNotificationType
    ticketId?: bigint
    reportId?: string
    message: string
  }) {
    return prisma.csaNotification.create({ data })
  },

  async findByAdmin(adminId: string, opts: { unreadOnly?: boolean; skip: number; take: number }) {
    const where = { adminId, ...(opts.unreadOnly ? { isRead: false } : {}) }
    const [items, total] = await Promise.all([
      prismaRead.csaNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          ticket: { select: { id: true, publicId: true, type: true, subType: true, status: true } },
        },
      }),
      prismaRead.csaNotification.count({ where }),
    ])
    return { items, total }
  },

  async countUnread(adminId: string) {
    return prismaRead.csaNotification.count({ where: { adminId, isRead: false } })
  },

  async markRead(adminId: string, ids: bigint[]) {
    return prisma.csaNotification.updateMany({
      where: { adminId, id: { in: ids }, isRead: false },
      data: { isRead: true, readAt: new Date() },
    })
  },

  async markAllRead(adminId: string) {
    return prisma.csaNotification.updateMany({
      where: { adminId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    })
  },
}
