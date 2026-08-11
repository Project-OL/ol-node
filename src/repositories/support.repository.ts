import { prisma, prismaRead } from '../config/database'
import type {
  SupportTicketStatus,
  SupportTicketType,
  SupportTicketPriority,
  SupportTicketResolution,
  SupportMessageSenderType,
  Prisma,
} from '@prisma/client'

/** Business reference types for payment-conflict tickets. */
export type SupportTicketRefType = 'WITHDRAWAL' | 'POINT_TRANSFER' | 'COIN_TRANSFER' | 'LEDGER_ENTRY'

const noteAdminSelect = {
  id: true,
  displayName: true,
  username: true,
} as const

const senderSelect = {
  id: true,
  publicId: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  isSupport: true,
} as const

const ticketOwnerSelect = {
  id: true,
  publicId: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
} as const

const lastMessagePreviewSelect = {
  id: true,
  content: true,
  senderType: true,
  createdAt: true,
  imageUrl: true,
  isAutoReply: true,
} as const

export const supportRepository = {
  async createTicket(data: {
    userId: string
    type: SupportTicketType
    subType: string
    description: string
    imageUrl?: string
    priority?: SupportTicketPriority
    refType?: SupportTicketRefType
    refId?: string
  }) {
    return prisma.supportTicket.create({
      data: { ...data, status: 'AWAITING_REPLY' },
    })
  },

  async findTicketById(ticketId: bigint) {
    return prismaRead.supportTicket.findUnique({
      where: { id: ticketId },
      include: { user: { select: ticketOwnerSelect } },
    })
  },

  async findTicketsByUser(
    userId: string,
    opts: { status?: SupportTicketStatus; skip: number; take: number },
  ) {
    const where = {
      userId,
      ...(opts.status ? { status: opts.status } : {}),
    }
    const [tickets, total] = await Promise.all([
      prismaRead.supportTicket.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: lastMessagePreviewSelect,
          },
        },
      }),
      prismaRead.supportTicket.count({ where }),
    ])
    return { tickets, total }
  },

  async findAllTickets(opts: { status?: SupportTicketStatus; skip: number; take: number }) {
    const where = opts.status ? { status: opts.status } : {}
    const [tickets, total] = await Promise.all([
      prismaRead.supportTicket.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          user: { select: ticketOwnerSelect },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: lastMessagePreviewSelect,
          },
        },
      }),
      prismaRead.supportTicket.count({ where }),
    ])
    return { tickets, total }
  },

  async updateTicketStatus(
    ticketId: bigint,
    status: SupportTicketStatus,
    extra?: {
      closedAt?: Date
      closedByUserId?: string
      assignedAdminId?: string | null
      assignedAt?: Date | null
      resolution?: SupportTicketResolution | null
      resolvedAt?: Date | null
      firstResponseAt?: Date
      priority?: SupportTicketPriority
    },
  ) {
    return prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status, updatedAt: new Date(), ...extra },
    })
  },

  async assignTicket(
    ticketId: bigint,
    adminId: string,
    opts?: { setStatusAssigned?: boolean },
  ) {
    return prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        assignedAdminId: adminId,
        assignedAt: new Date(),
        ...(opts?.setStatusAssigned ? { status: 'ASSIGNED' as SupportTicketStatus } : {}),
      },
      include: { user: { select: ticketOwnerSelect } },
    })
  },

  /** Open-ticket load per admin (anything not CLOSED counts toward capacity). */
  async countOpenByAdminIds(adminIds: string[]) {
    if (adminIds.length === 0) return new Map<string, number>()
    const rows = await prismaRead.supportTicket.groupBy({
      by: ['assignedAdminId'],
      where: { assignedAdminId: { in: adminIds }, status: { not: 'CLOSED' } },
      _count: { _all: true },
    })
    const map = new Map<string, number>()
    for (const row of rows) {
      if (row.assignedAdminId) map.set(row.assignedAdminId, row._count._all)
    }
    return map
  },

  async findActiveTicketsByAdmin(adminId: string) {
    return prismaRead.supportTicket.findMany({
      where: { assignedAdminId: adminId, status: { not: 'CLOSED' } },
      orderBy: { createdAt: 'asc' },
    })
  },

  async findAdminTickets(opts: {
    status?: SupportTicketStatus
    priority?: SupportTicketPriority
    type?: SupportTicketType
    assignedAdminId?: string
    unassigned?: boolean
    /** When true, only tickets that have a star rating (typically with status=CLOSED). */
    ratedOnly?: boolean
    skip: number
    take: number
  }) {
    const where: Prisma.SupportTicketWhereInput = {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.assignedAdminId ? { assignedAdminId: opts.assignedAdminId } : {}),
      ...(opts.unassigned ? { assignedAdminId: null, status: { not: 'CLOSED' } } : {}),
      ...(opts.ratedOnly ? { rating: { not: null } } : {}),
    }
    const [tickets, total] = await Promise.all([
      prismaRead.supportTicket.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
        skip: opts.skip,
        take: opts.take,
        include: {
          user: { select: ticketOwnerSelect },
          assignedAdmin: { select: noteAdminSelect },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: lastMessagePreviewSelect,
          },
        },
      }),
      prismaRead.supportTicket.count({ where }),
    ])
    return { tickets, total }
  },

  async findTicketByIdForAdmin(ticketId: bigint) {
    return prismaRead.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        user: { select: ticketOwnerSelect },
        assignedAdmin: { select: noteAdminSelect },
      },
    })
  },

  async createNote(data: { ticketId: bigint; adminId: string; content: string }) {
    return prisma.supportTicketNote.create({
      data,
      include: { admin: { select: noteAdminSelect } },
    })
  },

  async findNotes(ticketId: bigint) {
    return prismaRead.supportTicketNote.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
      include: { admin: { select: noteAdminSelect } },
    })
  },

  /** Per-CSA performance counters for the stats endpoints. */
  async csaPerformance(adminId: string) {
    const [open, resolvedTotal, rejectedTotal, rated, responded, resolved30d] = await Promise.all([
      prismaRead.supportTicket.count({
        where: { assignedAdminId: adminId, status: { not: 'CLOSED' } },
      }),
      prismaRead.supportTicket.count({
        where: { assignedAdminId: adminId, resolution: 'RESOLVED' },
      }),
      prismaRead.supportTicket.count({
        where: { assignedAdminId: adminId, resolution: 'REJECTED' },
      }),
      prismaRead.supportTicket.aggregate({
        where: { assignedAdminId: adminId, rating: { not: null } },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      prismaRead.supportTicket.findMany({
        where: { assignedAdminId: adminId, firstResponseAt: { not: null } },
        select: { createdAt: true, firstResponseAt: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prismaRead.supportTicket.count({
        where: {
          assignedAdminId: adminId,
          resolution: { not: null },
          resolvedAt: { gt: new Date(Date.now() - 30 * 86400_000) },
        },
      }),
    ])

    let avgFirstResponseMs: number | null = null
    if (responded.length > 0) {
      const totalMs = responded.reduce(
        (sum, t) => sum + (t.firstResponseAt!.getTime() - t.createdAt.getTime()),
        0,
      )
      avgFirstResponseMs = Math.round(totalMs / responded.length)
    }

    return {
      openTickets: open,
      resolvedTotal,
      rejectedTotal,
      resolved30d,
      avgRating: rated._avg.rating,
      ratingCount: rated._count.rating,
      avgFirstResponseMs,
    }
  },

  async updateReadPointer(ticketId: bigint, actor: 'USER' | 'SUPPORT', messageId: bigint) {
    const data =
      actor === 'USER' ? { userLastReadMessageId: messageId } : { csLastReadMessageId: messageId }
    return prisma.supportTicket.update({
      where: { id: ticketId },
      data,
    })
  },

  async rateTicket(ticketId: bigint, rating: number) {
    return prisma.supportTicket.update({
      where: { id: ticketId },
      data: { rating, ratedAt: new Date() },
    })
  },

  async createMessage(data: {
    ticketId: bigint
    senderUserId?: string
    senderType: SupportMessageSenderType
    content: string
    imageUrl?: string
    isAutoReply?: boolean
  }) {
    return prisma.supportMessage.create({
      data,
      include: {
        sender: { select: senderSelect },
      },
    })
  },

  async findMessages(ticketId: bigint, opts: { cursor?: bigint; take: number }) {
    return prismaRead.supportMessage.findMany({
      where: {
        ticketId,
        ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.take,
      include: {
        sender: { select: senderSelect },
      },
    })
  },
}
