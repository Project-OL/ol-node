import { prisma, prismaRead } from '../config/database'
import type {
  SupportTicketStatus,
  SupportTicketType,
  SupportMessageSenderType,
} from '@prisma/client'

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
    extra?: { closedAt?: Date; closedByUserId?: string },
  ) {
    return prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status, updatedAt: new Date(), ...extra },
    })
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
    return prisma.supportMessage.create({ data })
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
