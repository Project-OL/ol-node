import { redisClient, RedisKeys, SUPPORT_TICKET_LIST_TTL } from '../config/redis'
import type { SupportTicketStatus, SupportTicketType } from '@prisma/client'
import { supportRepository } from '../repositories/support.repository'
import { storageService } from './storage.service'
import { supportAssignmentService } from './supportAssignment.service'
import { csaNotificationService } from './csaNotification.service'
import { notifySupportTicketMessage } from './supportRealtime.service'
import { AppError } from '../middlewares/errorHandler'
import { SUPPORT_TYPE_CONFIG, isValidSubType, getDefaultPriority } from '../config/support-types.config'
import type {
  SupportUploadUrlInput,
  CreateTicketInput,
  SendMessageInput,
  RateTicketInput,
  GetTicketsQuery,
  GetMessagesQuery,
  GetAllTicketsQuery,
} from '../models/support.schemas'
import { formatUserName } from '../utils/user-display'

/** Agency promotion / CS force-exit use explicit admin routes (`/admin/agency/*`); do not auto-invoke from ticket lifecycle here. */
const AUTO_REPLY_CONTENT = 'Thank you for your feedback, we will reply you within 24 hours.'

const PRESIGN_TTL_SEC = 600

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, jsonValue) =>
      typeof jsonValue === 'bigint' ? jsonValue.toString() : jsonValue,
    ),
  ) as T
}

function withName<T extends { firstName?: string | null; lastName?: string | null } | null | undefined>(
  u: T,
): T extends null | undefined ? T : T & { name: string } {
  if (u == null) return u as any
  return { ...u, name: formatUserName(u) } as any
}

async function invalidateCaches(userId: string, ticketId: bigint): Promise<void> {
  await Promise.all([
    redisClient.del(RedisKeys.supportTicketList(userId)),
    redisClient.del(RedisKeys.supportTicketDetail(ticketId)),
  ])
}

function hasUnreadForActor(
  ticket: { userLastReadMessageId: bigint | null; csLastReadMessageId: bigint | null },
  lastMessage: { id: bigint; senderType: 'USER' | 'SUPPORT' } | undefined,
  actorIsCS: boolean,
): boolean {
  if (!lastMessage) return false
  if (actorIsCS) {
    if (lastMessage.senderType === 'SUPPORT') return false
    if (!ticket.csLastReadMessageId) return true
    return ticket.csLastReadMessageId < lastMessage.id
  }
  if (lastMessage.senderType === 'USER') return false
  if (!ticket.userLastReadMessageId) return true
  return ticket.userLastReadMessageId < lastMessage.id
}

function ticketUserFlags(ticket: { status: SupportTicketStatus; rating: number | null }) {
  return {
    canRate: ticket.status === 'CLOSED' && ticket.rating == null,
  }
}

export const supportService = {
  getTicketTypes() {
    return SUPPORT_TYPE_CONFIG
  },

  async getUploadUrl(callerId: string, callerIsCS: boolean, input: SupportUploadUrlInput) {
    let s3Prefix: string

    if (input.folder === 'ticket') {
      s3Prefix = `support/tickets/${callerId}`
    } else {
      if (!input.ticketId) {
        throw new AppError(
          400,
          'ticketId is required for message image uploads',
          'TICKET_ID_REQUIRED',
        )
      }
      const ticket = await supportRepository.findTicketById(input.ticketId)
      if (!ticket) {
        throw new AppError(404, 'Ticket not found', 'TICKET_NOT_FOUND')
      }
      if (!callerIsCS && ticket.userId !== callerId) {
        throw new AppError(403, 'Forbidden', 'TICKET_ACCESS_DENIED')
      }
      if (ticket.status === 'CLOSED') {
        throw new AppError(409, 'Cannot upload to a closed ticket', 'TICKET_CLOSED')
      }
      s3Prefix = `support/messages/${input.ticketId}`
    }

    const safeFileName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const key = `${s3Prefix}/${Date.now()}_${safeFileName}`

    const uploadUrl = await storageService.getPresignedPutUrl(key, input.mimeType, PRESIGN_TTL_SEC)
    const publicUrl = storageService.getCdnOrS3PublicUrl(key)

    return { uploadUrl, publicUrl, key }
  },

  async createTicket(userId: string, input: CreateTicketInput) {
    if (!isValidSubType(input.type, input.subType)) {
      throw new AppError(400, 'Invalid subType for the given ticket type', 'INVALID_SUBTYPE')
    }

    const ticket = await supportRepository.createTicket({
      userId,
      type: input.type as SupportTicketType,
      subType: input.subType,
      description: input.description,
      imageUrl: input.imageUrl,
      priority: getDefaultPriority(input.subType),
      refType: input.transactionRef?.refType,
      refId: input.transactionRef?.refId,
    })

    await supportRepository.createMessage({
      ticketId: ticket.id,
      senderUserId: undefined,
      senderType: 'SUPPORT',
      content: AUTO_REPLY_CONTENT,
      isAutoReply: true,
    })

    const updated = await supportRepository.updateTicketStatus(ticket.id, 'OPEN')

    await redisClient.del(RedisKeys.supportTicketList(userId))

    // Auto-assignment must never fail ticket creation — an unassigned OPEN
    // ticket is a designed state (claimable from the workbench queue).
    try {
      await supportAssignmentService.assignTicket(ticket.id)
    } catch (err) {
      console.warn('[support] auto-assignment failed; ticket left unassigned', {
        ticketId: ticket.id.toString(),
        err,
      })
    }

    return updated
  },

  async listMyTickets(userId: string, query: GetTicketsQuery) {
    const useCache = !query.status && query.page === 1

    if (useCache) {
      const cached = await redisClient.get(RedisKeys.supportTicketList(userId))
      if (cached) return JSON.parse(cached) as unknown
    }

    const skip = (query.page - 1) * query.limit
    const { tickets, total } = await supportRepository.findTicketsByUser(userId, {
      status: query.status as SupportTicketStatus | undefined,
      skip,
      take: query.limit,
    })

    const response = {
      tickets: tickets.map((ticket) => {
        const lastMessage = ticket.messages[0] as
          | { id: bigint; senderType: 'USER' | 'SUPPORT' }
          | undefined
        return {
          ...ticket,
          ...ticketUserFlags(ticket),
          hasUnreadMessages: hasUnreadForActor(
            {
              userLastReadMessageId: ticket.userLastReadMessageId ?? null,
              csLastReadMessageId: ticket.csLastReadMessageId ?? null,
            },
            lastMessage,
            false,
          ),
        }
      }),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasMore: skip + tickets.length < total,
      },
    }
    const safeResponse = toJsonSafe(response)

    if (useCache) {
      await redisClient.setex(
        RedisKeys.supportTicketList(userId),
        SUPPORT_TICKET_LIST_TTL,
        JSON.stringify(safeResponse),
      )
    }

    return safeResponse
  },

  async getTicketDetail(
    ticketId: bigint,
    callerId: string,
    callerIsCS: boolean,
    messageQuery: GetMessagesQuery,
  ) {
    const ticket = await supportRepository.findTicketById(ticketId)
    if (!ticket) throw new AppError(404, 'Ticket not found', 'TICKET_NOT_FOUND')

    if (!callerIsCS && ticket.userId !== callerId) {
      throw new AppError(403, 'Forbidden', 'TICKET_ACCESS_DENIED')
    }

    const messages = await supportRepository.findMessages(ticketId, {
      cursor: messageQuery.cursor,
      take: messageQuery.limit,
    })

    const chronological = [...messages].reverse()
    const latestMessage = messages[0]
    if (latestMessage) {
      await supportRepository.updateReadPointer(
        ticketId,
        callerIsCS ? 'SUPPORT' : 'USER',
        latestMessage.id,
      )
    }

    return toJsonSafe({
      ticket: {
        ...ticket,
        user: withName(ticket.user),
        ...ticketUserFlags(ticket),
      },
      messages: chronological.map((m) => ({
        ...m,
        sender: withName(m.sender),
      })),
      hasMore: messages.length === messageQuery.limit,
      nextCursor:
        messages.length === messageQuery.limit ? String(messages[messages.length - 1]!.id) : null,
    })
  },

  async sendMessage(
    ticketId: bigint,
    callerId: string,
    callerIsCS: boolean,
    input: SendMessageInput,
  ) {
    const ticket = await supportRepository.findTicketById(ticketId)
    if (!ticket) throw new AppError(404, 'Ticket not found', 'TICKET_NOT_FOUND')

    if (!callerIsCS && ticket.userId !== callerId) {
      throw new AppError(403, 'Forbidden', 'TICKET_ACCESS_DENIED')
    }

    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Ticket is closed and no longer accepts messages', 'TICKET_CLOSED')
    }

    const senderType = callerIsCS ? 'SUPPORT' : 'USER'
    const nextStatus = callerIsCS ? 'OPEN' : 'AWAITING_REPLY'
    // A user message on a PENDING_REVIEW ticket contests the resolution —
    // clear it and put the ticket back in the CS queue (auto-close job
    // re-checks status and becomes a no-op).
    const contestsResolution = !callerIsCS && ticket.status === 'PENDING_REVIEW'

    const [message] = await Promise.all([
      supportRepository.createMessage({
        ticketId,
        senderUserId: callerId,
        senderType,
        content: input.content,
        imageUrl: input.imageUrl,
      }),
      supportRepository.updateTicketStatus(
        ticketId,
        nextStatus,
        contestsResolution ? { resolution: null, resolvedAt: null } : undefined,
      ),
    ])
    await supportRepository.updateReadPointer(ticketId, callerIsCS ? 'SUPPORT' : 'USER', message.id)

    await invalidateCaches(ticket.userId, ticketId)

    if (!callerIsCS && ticket.assignedAdminId) {
      await csaNotificationService.notify(
        ticket.assignedAdminId,
        'TICKET_REPLY',
        `New reply on ticket ${ticket.publicId}`,
        { ticketId },
      )
    }

    void notifySupportTicketMessage({
      ticketId,
      ticketPublicId: ticket.publicId,
      ownerUserId: ticket.userId,
      assignedAdminId: ticket.assignedAdminId,
      message: {
        id: message.id,
        publicId: message.publicId,
        senderType: message.senderType,
        senderUserId: message.senderUserId,
        content: message.content,
        imageUrl: message.imageUrl,
        isAutoReply: message.isAutoReply,
        createdAt: message.createdAt,
      },
    }).catch((err) => {
      console.warn('[support] realtime notify failed', { ticketId: ticketId.toString(), err })
    })

    return toJsonSafe({
      ...message,
      sender: withName(message.sender),
    })
  },

  async closeTicket(ticketId: bigint, csUserId: string) {
    const ticket = await supportRepository.findTicketById(ticketId)
    if (!ticket) throw new AppError(404, 'Ticket not found', 'TICKET_NOT_FOUND')

    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Ticket is already closed', 'TICKET_ALREADY_CLOSED')
    }

    const now = new Date()
    const resolution = ticket.resolution ?? 'RESOLVED'
    await supportRepository.createMessage({
      ticketId,
      senderType: 'SUPPORT',
      content:
        'This ticket has been closed by support. Please rate your experience (1–5 stars).',
    })
    const updated = await supportRepository.updateTicketStatus(ticketId, 'CLOSED', {
      closedAt: now,
      closedByUserId: csUserId,
      resolution,
      resolvedAt: ticket.resolvedAt ?? now,
    })

    await invalidateCaches(ticket.userId, ticketId)

    return toJsonSafe(updated)
  },

  /** Owner accepts a PENDING_REVIEW resolution and closes the ticket. */
  async confirmClose(ticketId: bigint, userId: string) {
    const ticket = await supportRepository.findTicketById(ticketId)
    if (!ticket) throw new AppError(404, 'Ticket not found', 'TICKET_NOT_FOUND')

    if (ticket.userId !== userId) {
      throw new AppError(403, 'Forbidden', 'TICKET_ACCESS_DENIED')
    }
    if (ticket.status !== 'PENDING_REVIEW') {
      throw new AppError(
        409,
        'Only tickets pending review can be confirmed closed',
        'TICKET_NOT_PENDING_REVIEW',
      )
    }

    const updated = await supportRepository.updateTicketStatus(ticketId, 'CLOSED', {
      closedAt: new Date(),
      closedByUserId: userId,
    })

    await supportRepository.createMessage({
      ticketId,
      senderType: 'SUPPORT',
      content: 'Thanks for confirming. Please rate your experience (1–5 stars).',
    })

    await invalidateCaches(userId, ticketId)

    return toJsonSafe({
      ...updated,
      canRate: true,
    })
  },

  async rateTicket(ticketId: bigint, userId: string, input: RateTicketInput) {
    const ticket = await supportRepository.findTicketById(ticketId)
    if (!ticket) throw new AppError(404, 'Ticket not found', 'TICKET_NOT_FOUND')

    if (ticket.userId !== userId) {
      throw new AppError(403, 'Forbidden', 'TICKET_ACCESS_DENIED')
    }
    if (ticket.status !== 'CLOSED') {
      throw new AppError(409, 'Ticket must be closed before it can be rated', 'TICKET_NOT_CLOSED')
    }
    if (ticket.rating != null) {
      throw new AppError(409, 'Ticket has already been rated', 'TICKET_ALREADY_RATED')
    }

    const updated = await supportRepository.rateTicket(ticketId, input.rating)
    await invalidateCaches(userId, ticketId)

    return toJsonSafe({
      ...updated,
      canRate: false,
    })
  },

  /**
   * BullMQ auto-close: fires 24h after a ticket entered PENDING_REVIEW.
   * No-op unless the ticket is still PENDING_REVIEW (user may have contested
   * or confirmed in the meantime).
   */
  async processAutocloseJob(ticketId: bigint) {
    const ticket = await supportRepository.findTicketById(ticketId)
    if (!ticket || ticket.status !== 'PENDING_REVIEW') return

    const now = new Date()
    await supportRepository.createMessage({
      ticketId,
      senderType: 'SUPPORT',
      content:
        'This ticket was closed automatically. Please rate your experience (1–5 stars).',
    })
    await supportRepository.updateTicketStatus(ticketId, 'CLOSED', {
      closedAt: now,
      // Preserve resolve/reject already set at PENDING_REVIEW entry.
      resolution: ticket.resolution ?? 'RESOLVED',
      resolvedAt: ticket.resolvedAt ?? now,
    })
    await invalidateCaches(ticket.userId, ticketId)
  },

  async listAllTickets(query: GetAllTicketsQuery) {
    const skip = (query.page - 1) * query.limit
    const { tickets, total } = await supportRepository.findAllTickets({
      status: query.status as SupportTicketStatus | undefined,
      skip,
      take: query.limit,
    })

    return toJsonSafe({
      tickets: tickets.map((ticket) => {
        const lastMessage = ticket.messages[0] as
          | { id: bigint; senderType: 'USER' | 'SUPPORT' }
          | undefined
        return {
          ...ticket,
          user: withName(ticket.user),
          hasUnreadMessages: hasUnreadForActor(
            {
              userLastReadMessageId: ticket.userLastReadMessageId ?? null,
              csLastReadMessageId: ticket.csLastReadMessageId ?? null,
            },
            lastMessage,
            true,
          ),
        }
      }),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasMore: skip + tickets.length < total,
      },
    })
  },
}
