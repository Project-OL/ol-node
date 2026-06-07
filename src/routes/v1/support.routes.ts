import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { requireSupportAuth } from '../../middlewares/requireSupportAuth'
import { supportTicketCreateRateLimit } from '../../middlewares/rateLimitAuth'
import { supportService } from '../../services/support.service'
import { AppError } from '../../middlewares/errorHandler'
import type { JwtAccessPayload } from '../../models/types'
import {
  SupportUploadUrlSchema,
  CreateTicketSchema,
  SendMessageSchema,
  RateTicketSchema,
  GetTicketsQuerySchema,
  GetMessagesQuerySchema,
  GetAllTicketsQuerySchema,
} from '../../models/support.schemas'

const preAuth = [authenticate]

export async function supportRoutes(app: FastifyInstance) {
  app.get(
    '/ticket-types',
    { preHandler: preAuth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ types: supportService.getTicketTypes() })
    },
  )

  app.post(
    '/upload-url',
    { preHandler: preAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = SupportUploadUrlSchema.parse(req.body)
      const userId = req.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const jwtUser = req.user as JwtAccessPayload
      const result = await supportService.getUploadUrl(userId, Boolean(jwtUser.isSupport), body)
      return reply.send(result)
    },
  )

  app.post(
    '/tickets',
    { preHandler: [...preAuth, supportTicketCreateRateLimit] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = CreateTicketSchema.parse(req.body)
      const userId = req.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const ticket = await supportService.createTicket(userId, body)
      return reply.status(201).send({ ticket })
    },
  )

  app.get('/tickets', { preHandler: preAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const query = GetTicketsQuerySchema.parse(req.query)
    const userId = req.userId
    if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const result = await supportService.listMyTickets(userId, query)
    return reply.send(result)
  })

  app.get(
    '/tickets/:ticketId',
    { preHandler: preAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { ticketId } = req.params as { ticketId: string }
      const msgQuery = GetMessagesQuerySchema.parse(req.query)
      const userId = req.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const jwtUser = req.user as JwtAccessPayload
      const result = await supportService.getTicketDetail(
        BigInt(ticketId),
        userId,
        Boolean(jwtUser.isSupport),
        msgQuery,
      )
      return reply.send(result)
    },
  )

  app.post(
    '/tickets/:ticketId/messages',
    { preHandler: preAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { ticketId } = req.params as { ticketId: string }
      const body = SendMessageSchema.parse(req.body)
      const userId = req.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const jwtUser = req.user as JwtAccessPayload
      const message = await supportService.sendMessage(
        BigInt(ticketId),
        userId,
        Boolean(jwtUser.isSupport),
        body,
      )
      return reply.status(201).send({ message })
    },
  )

  app.post(
    '/tickets/:ticketId/rate',
    { preHandler: preAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { ticketId } = req.params as { ticketId: string }
      const body = RateTicketSchema.parse(req.body)
      const userId = req.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const jwtUser = req.user as JwtAccessPayload
      if (jwtUser.isSupport) {
        throw new AppError(403, 'CS actors cannot rate tickets', 'CS_CANNOT_RATE')
      }
      const ticket = await supportService.rateTicket(BigInt(ticketId), userId, body)
      return reply.send({ ticket })
    },
  )

  app.get(
    '/cs/tickets',
    { preHandler: [...preAuth, requireSupportAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = GetAllTicketsQuerySchema.parse(req.query)
      const result = await supportService.listAllTickets(query)
      return reply.send(result)
    },
  )

  app.patch(
    '/cs/tickets/:ticketId/close',
    { preHandler: [...preAuth, requireSupportAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { ticketId } = req.params as { ticketId: string }
      const userId = req.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const ticket = await supportService.closeTicket(BigInt(ticketId), userId)
      return reply.send({ ticket })
    },
  )

  app.post(
    '/cs/tickets/:ticketId/reply',
    { preHandler: [...preAuth, requireSupportAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { ticketId } = req.params as { ticketId: string }
      const body = SendMessageSchema.parse(req.body)
      const userId = req.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const message = await supportService.sendMessage(BigInt(ticketId), userId, true, body)
      return reply.status(201).send({ message })
    },
  )
}
