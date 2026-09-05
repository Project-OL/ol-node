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
export type SupportTicketRefType =
  | 'WITHDRAWAL'
  | 'POINT_TRANSFER'
  | 'COIN_TRANSFER'
  | 'LEDGER_ENTRY'

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

/**
 * Runs a paginated ticket query across ordered status tiers — open/in-progress first, pending
 * review next, closed last — so the list sorts by lifecycle stage without needing an enum-order
 * migration (Postgres enum declaration order doesn't match the desired display order: OPEN,
 * AWAITING_REPLY, CLOSED, ASSIGNED, PENDING_REVIEW). `tierStatusFilters` partitions every ticket
 * matching `baseWhere` into disjoint groups, highest-priority (shown first) to lowest; skip/take
 * are resolved across the combined tiers so pagination stays correct at tier boundaries.
 */
async function findByStatusTiers<T extends Prisma.SupportTicketInclude | undefined>(params: {
  baseWhere: Prisma.SupportTicketWhereInput
  tierStatusFilters: Array<NonNullable<Prisma.SupportTicketWhereInput['status']>>
  orderBy:
    | Prisma.SupportTicketOrderByWithRelationInput
    | Prisma.SupportTicketOrderByWithRelationInput[]
  skip: number
  take: number
  include?: T
}) {
  const { baseWhere, tierStatusFilters, orderBy, skip, take, include } = params
  const tierWheres = tierStatusFilters.map(
    (status): Prisma.SupportTicketWhereInput => ({ ...baseWhere, status }),
  )
  const tierTotals = await Promise.all(
    tierWheres.map((where) => prismaRead.supportTicket.count({ where })),
  )

  // Prisma's payload-inference conditional types don't resolve through a generic `include`
  // passed across a function boundary, so each findMany result is cast to the payload shape
  // computed from that same generic below — the actual runtime shape is whatever each caller's
  // `include` literal produces, which is what both sides describe.
  type Row = Prisma.SupportTicketGetPayload<{ include: T }>
  const tickets: Row[] = []
  let skipRemaining = skip
  for (let i = 0; i < tierWheres.length && tickets.length < take; i++) {
    const tierTotal = tierTotals[i]
    if (skipRemaining >= tierTotal) {
      skipRemaining -= tierTotal
      continue
    }
    const rows = await prismaRead.supportTicket.findMany({
      where: tierWheres[i],
      orderBy,
      skip: skipRemaining,
      take: take - tickets.length,
      include,
    })
    tickets.push(...(rows as unknown as Row[]))
    skipRemaining = 0
  }

  return { tickets, total: tierTotals.reduce((sum, n) => sum + n, 0) }
}

/** Shared tier order for every default (no explicit status filter) ticket list. */
const TICKET_STAGE_TIER_FILTERS: Array<NonNullable<Prisma.SupportTicketWhereInput['status']>> = [
  { notIn: ['PENDING_REVIEW', 'CLOSED'] },
  'PENDING_REVIEW',
  'CLOSED',
]

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
    const include = {
      messages: {
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: lastMessagePreviewSelect,
      },
    }
    if (opts.status) {
      const where = { userId, status: opts.status }
      const [tickets, total] = await Promise.all([
        prismaRead.supportTicket.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: opts.skip,
          take: opts.take,
          include,
        }),
        prismaRead.supportTicket.count({ where }),
      ])
      return { tickets, total }
    }
    return findByStatusTiers({
      baseWhere: { userId },
      tierStatusFilters: TICKET_STAGE_TIER_FILTERS,
      orderBy: { updatedAt: 'desc' },
      skip: opts.skip,
      take: opts.take,
      include,
    })
  },

  async findAllTickets(opts: { status?: SupportTicketStatus; skip: number; take: number }) {
    const include = {
      user: { select: ticketOwnerSelect },
      messages: {
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: lastMessagePreviewSelect,
      },
    }
    if (opts.status) {
      const where = { status: opts.status }
      const [tickets, total] = await Promise.all([
        prismaRead.supportTicket.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: opts.skip,
          take: opts.take,
          include,
        }),
        prismaRead.supportTicket.count({ where }),
      ])
      return { tickets, total }
    }
    return findByStatusTiers({
      baseWhere: {},
      tierStatusFilters: TICKET_STAGE_TIER_FILTERS,
      orderBy: { updatedAt: 'desc' },
      skip: opts.skip,
      take: opts.take,
      include,
    })
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

  async assignTicket(ticketId: bigint, adminId: string, opts?: { setStatusAssigned?: boolean }) {
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

  /** Closed-ticket count per assigned CSA (status CLOSED). */
  async countClosedByAdminIds(adminIds: string[]) {
    if (adminIds.length === 0) return new Map<string, number>()
    const rows = await prismaRead.supportTicket.groupBy({
      by: ['assignedAdminId'],
      where: { assignedAdminId: { in: adminIds }, status: 'CLOSED' },
      _count: { _all: true },
    })
    const map = new Map<string, number>()
    for (const row of rows) {
      if (row.assignedAdminId) map.set(row.assignedAdminId, row._count._all)
    }
    return map
  },

  /** Star-rating aggregates per assigned CSA. */
  async ratingStatsByAdminIds(adminIds: string[]) {
    if (adminIds.length === 0)
      return new Map<string, { avgRating: number | null; ratingCount: number }>()
    const rows = await prismaRead.supportTicket.groupBy({
      by: ['assignedAdminId'],
      where: { assignedAdminId: { in: adminIds }, rating: { not: null } },
      _avg: { rating: true },
      _count: { rating: true },
    })
    const map = new Map<string, { avgRating: number | null; ratingCount: number }>()
    for (const row of rows) {
      if (!row.assignedAdminId) continue
      map.set(row.assignedAdminId, {
        avgRating: row._avg.rating,
        ratingCount: row._count.rating,
      })
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
    /** Only tickets whose resolvedAt is at least this many days ago (CSA resolve/reject). */
    minDaysSinceReviewed?: number
    /** Only tickets whose resolvedAt is within this many days (inclusive). */
    maxDaysSinceReviewed?: number
    skip: number
    take: number
  }) {
    const resolvedAtFilter: Prisma.DateTimeNullableFilter | undefined = (() => {
      const hasMin = opts.minDaysSinceReviewed != null && opts.minDaysSinceReviewed >= 0
      const hasMax = opts.maxDaysSinceReviewed != null && opts.maxDaysSinceReviewed >= 0
      if (!hasMin && !hasMax) return undefined
      const now = Date.now()
      const filter: Prisma.DateTimeNullableFilter = { not: null }
      if (hasMin) {
        filter.lte = new Date(now - opts.minDaysSinceReviewed! * 86_400_000)
      }
      if (hasMax) {
        filter.gte = new Date(now - opts.maxDaysSinceReviewed! * 86_400_000)
      }
      return filter
    })()

    const include = {
      user: { select: ticketOwnerSelect },
      assignedAdmin: { select: noteAdminSelect },
      messages: {
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: lastMessagePreviewSelect,
      },
    }
    const orderBy: Prisma.SupportTicketOrderByWithRelationInput[] = [
      { priority: 'desc' },
      { updatedAt: 'desc' },
    ]

    if (opts.status) {
      const where: Prisma.SupportTicketWhereInput = {
        status: opts.status,
        ...(opts.priority ? { priority: opts.priority } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.assignedAdminId ? { assignedAdminId: opts.assignedAdminId } : {}),
        ...(opts.unassigned ? { assignedAdminId: null } : {}),
        ...(opts.ratedOnly ? { rating: { not: null } } : {}),
        ...(resolvedAtFilter ? { resolvedAt: resolvedAtFilter } : {}),
      }
      const [tickets, total] = await Promise.all([
        prismaRead.supportTicket.findMany({
          where,
          orderBy,
          skip: opts.skip,
          take: opts.take,
          include,
        }),
        prismaRead.supportTicket.count({ where }),
      ])
      return { tickets, total }
    }

    const baseWhere: Prisma.SupportTicketWhereInput = {
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.assignedAdminId ? { assignedAdminId: opts.assignedAdminId } : {}),
      ...(opts.unassigned ? { assignedAdminId: null } : {}),
      ...(opts.ratedOnly ? { rating: { not: null } } : {}),
      ...(resolvedAtFilter ? { resolvedAt: resolvedAtFilter } : {}),
    }
    return findByStatusTiers({
      baseWhere,
      tierStatusFilters: TICKET_STAGE_TIER_FILTERS,
      orderBy,
      skip: opts.skip,
      take: opts.take,
      include,
    })
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
