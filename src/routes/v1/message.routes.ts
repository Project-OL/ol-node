import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { rateLimitReaction } from '../../middlewares/rateLimitAuth'
import { AddReactionSchema, EditMessageSchema } from '../../models/messaging.schemas'
import { messagingService } from '../../services/messaging.service'
import { AppError } from '../../middlewares/errorHandler'

export default async function messageRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.post<{
    Params: { messageId: string }
    Body: unknown
  }>(
    '/:messageId/reactions',
    {
      preHandler: [...preAuth, rateLimitReaction],
      schema: {
        tags: ['Messages'],
        description: 'Add reaction to a message',
        params: {
          type: 'object',
          required: ['messageId'],
          properties: { messageId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { messageId: string }
        Body: unknown
      }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const parsed = AddReactionSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      await messagingService.addReaction(userId, request.params.messageId, parsed.data.emoji)
      return reply.code(201).send({ success: true })
    },
  )

  app.delete<{ Params: { messageId: string; emoji: string } }>(
    '/:messageId/reactions/:emoji',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Messages'],
        description: 'Remove reaction from a message',
        params: {
          type: 'object',
          required: ['messageId', 'emoji'],
          properties: {
            messageId: { type: 'string', minLength: 1 },
            emoji: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { messageId: string; emoji: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      await messagingService.removeReaction(userId, request.params.messageId, request.params.emoji)
      return reply.code(204).send()
    },
  )

  app.delete<{ Params: { messageId: string } }>(
    '/:messageId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Messages'],
        description: 'Delete own message (only within the configured edit/delete window of sending)',
        params: {
          type: 'object',
          required: ['messageId'],
          properties: { messageId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { messageId: string } }>, reply: FastifyReply) => {
      const userId = request.userId!
      await messagingService.deleteMessage(userId, request.params.messageId)
      return reply.code(204).send()
    },
  )

  app.patch<{
    Params: { messageId: string }
    Body: unknown
  }>(
    '/:messageId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Messages'],
        description: 'Edit own message content (only within the configured edit/delete window of sending)',
        params: {
          type: 'object',
          required: ['messageId'],
          properties: { messageId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { messageId: string }
        Body: unknown
      }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const parsed = EditMessageSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const result = await messagingService.editMessage(
        userId,
        request.params.messageId,
        parsed.data.content,
      )
      return reply.code(200).send(result)
    },
  )
}
