import { csaNotificationRepository } from '../repositories/csaNotification.repository'
import { supportRepository } from '../repositories/support.repository'
import type { CsaNotificationType } from '@prisma/client'

export const csaNotificationService = {
  /**
   * Fire-and-forget safe: notification failures must never break the flow
   * that triggered them (ticket create, reply, reassign).
   */
  async notify(
    adminId: string,
    type: CsaNotificationType,
    message: string,
    ref?: { ticketId?: bigint; reportId?: string },
  ): Promise<void> {
    try {
      await csaNotificationRepository.create({
        adminId,
        type,
        message,
        ticketId: ref?.ticketId,
        reportId: ref?.reportId,
      })
    } catch (err) {
      console.error('[csa-notification] create failed', { adminId, type, err })
    }
  },

  async list(adminId: string, query: { unreadOnly?: boolean; page: number; limit: number }) {
    const { items, total } = await csaNotificationRepository.findByAdmin(adminId, {
      unreadOnly: query.unreadOnly,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    })
    return {
      notifications: items.map((n) => ({
        id: n.id.toString(),
        type: n.type,
        message: n.message,
        isRead: n.isRead,
        readAt: n.readAt,
        createdAt: n.createdAt,
        ticket: n.ticket
          ? {
              ticketId: n.ticket.publicId,
              type: n.ticket.type,
              subType: n.ticket.subType,
              status: n.ticket.status,
            }
          : null,
        reportId: n.reportId,
      })),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    }
  },

  async badge(adminId: string) {
    const [unreadCount, loadMap] = await Promise.all([
      csaNotificationRepository.countUnread(adminId),
      supportRepository.countOpenByAdminIds([adminId]),
    ])
    const myOpenTickets = loadMap.get(adminId) ?? 0
    const awaiting = await supportRepository.findAdminTickets({
      assignedAdminId: adminId,
      status: 'AWAITING_REPLY',
      skip: 0,
      take: 1,
    })
    return { unreadCount, myOpenTickets, myAwaitingReply: awaiting.total }
  },

  async markRead(adminId: string, ids?: string[]) {
    if (ids && ids.length > 0) {
      const parsed = ids
        .map((id) => {
          try {
            return BigInt(id)
          } catch {
            return null
          }
        })
        .filter((id): id is bigint => id !== null)
      const res = await csaNotificationRepository.markRead(adminId, parsed)
      return { marked: res.count }
    }
    const res = await csaNotificationRepository.markAllRead(adminId)
    return { marked: res.count }
  },
}
