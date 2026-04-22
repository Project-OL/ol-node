import { redisClient, RedisKeys, SUPPORT_TICKET_LIST_TTL } from '../config/redis'
import type { SupportTicketStatus, SupportTicketType } from '@prisma/client'
import { supportRepository } from '../repositories/support.repository'
import { storageService } from './storage.service'
import { AppError } from '../middlewares/errorHandler'
import { SUPPORT_TYPE_CONFIG, isValidSubType } from '../config/support-types.config'
import type {
  SupportUploadUrlInput,
  CreateTicketInput,
  SendMessageInput,
  RateTicketInput,
  GetTicketsQuery,
  GetMessagesQuery,
  GetAllTicketsQuery,
} from '../models/support.schemas'

const AUTO_REPLY_CONTENT =
  'Thank you for your feedback, we will reply you within 24 hours.'

const PRESIGN_TTL_SEC = 600

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, jsonValue) =>
      typeof jsonValue === 'bigint' ? jsonValue.toString() : jsonValue,
    ),
  ) as T
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
      ticket,
      messages: chronological,
      hasMore: messages.length === messageQuery.limit,
      nextCursor:
        messages.length === messageQuery.limit
          ? String(messages[messages.length - 1]!.id)
          : null,
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

    const [message] = await Promise.all([
      supportRepository.createMessage({
        ticketId,
        senderUserId: callerId,
        senderType,
        content: input.content,
        imageUrl: input.imageUrl,
      }),
      supportRepository.updateTicketStatus(ticketId, nextStatus),
    ])
    await supportRepository.updateReadPointer(ticketId, callerIsCS ? 'SUPPORT' : 'USER', message.id)

    await invalidateCaches(ticket.userId, ticketId)

    return toJsonSafe(message)
  },

  async closeTicket(ticketId: bigint, csUserId: string) {
    const ticket = await supportRepository.findTicketById(ticketId)
    if (!ticket) throw new AppError(404, 'Ticket not found', 'TICKET_NOT_FOUND')

    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Ticket is already closed', 'TICKET_ALREADY_CLOSED')
    }

    const updated = await supportRepository.updateTicketStatus(ticketId, 'CLOSED', {
      closedAt: new Date(),
      closedByUserId: csUserId,
    })

    await invalidateCaches(ticket.userId, ticketId)

    return toJsonSafe(updated)
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

    return toJsonSafe(updated)
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
