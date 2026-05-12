import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import {
  rateLimitConvCreate,
  rateLimitMsgSend,
  rateLimitMediaUpload,
} from '../../middlewares/rateLimitAuth'
import {
  CreateDMSchema,
  ListConversationsSchema,
  ListMessagesSchema,
  SendMessageSchema,
  MuteConversationSchema,
  GetUploadUrlsSchema,
} from '../../models/messaging.schemas'
import { messagingService } from '../../services/messaging.service'
import { uploadService } from '../../services/upload.service'
import { conversationRepository } from '../../repositories/conversation.repository'
import { AppError } from '../../middlewares/errorHandler'
import { requestTimeout } from '../../utils/requestTimeout'

const HEAVY_READ_TIMEOUT_MS = 15_000

export default async function conversationRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]
  const preAuthWithTimeout = [authenticate, requestTimeout(HEAVY_READ_TIMEOUT_MS)]

  app.post<{ Body: unknown }>(
    '/',
    {
      preHandler: [...preAuth, rateLimitConvCreate],
      schema: {
        tags: ['Conversations'],
        description: 'Create or get direct conversation',
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = CreateDMSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const { conversation, isNew } =
        await messagingService.getOrCreateDirectConversation(
          userId,
          parsed.data.recipientPublicId,
        )
      return reply.code(isNew ? 201 : 200).send({ conversation })
    },
  )

  app.get<{ Querystring: unknown }>(
    '/',
    {
      preHandler: preAuthWithTimeout,
      schema: {
        tags: ['Conversations'],
        description: 'List conversations',
      },
    },
    async (request: FastifyRequest<{ Querystring: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = ListConversationsSchema.safeParse(request.query)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await messagingService.listConversations(
        userId,
        parsed.data.cursor,
        parsed.data.limit,
      )
      return reply.send(result)
    },
  )

  app.get(
    '/dm-contacts',
    {
      preHandler: preAuthWithTimeout,
      schema: {
        tags: ['Conversations'],
        description: 'Get DM contacts (friends + following)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const contacts = await messagingService.getDmContacts(userId)
      return reply.send({ contacts })
    },
  )

  app.post<{ Body: unknown }>(
    '/upload-urls',
    {
      preHandler: [...preAuth, rateLimitMediaUpload],
      schema: {
        tags: ['Conversations'],
        description: 'Get S3 presigned URLs for message media',
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = GetUploadUrlsSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      if (parsed.data.conversationId) {
        const conv = await conversationRepository.findConversationById(
          parsed.data.conversationId,
          userId,
        )
        if (!conv) {
          throw new AppError(403, 'Not a member', 'FORBIDDEN')
        }
      }
      const urls = await uploadService.getMessageMediaUploadUrls(
        userId,
        parsed.data,
      )
      return reply.send(urls)
    },
  )

  app.get<{
    Params: { conversationId: string }
    Querystring: unknown
  }>(
    '/:conversationId/messages',
    {
      preHandler: preAuthWithTimeout,
      schema: {
        tags: ['Conversations'],
        description: 'List messages in a conversation',
        params: {
          type: 'object',
          required: ['conversationId'],
          properties: { conversationId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { conversationId: string }
        Querystring: unknown
      }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const { conversationId } = request.params
      if (!conversationId) {
        throw new AppError(400, 'conversationId required', 'INVALID_REQUEST')
      }
      const parsed = ListMessagesSchema.safeParse(request.query)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await messagingService.listMessages(
        userId,
        conversationId,
        parsed.data.cursor,
        parsed.data.limit,
      )
      return reply.send(result)
    },
  )

  app.post<{
    Params: { conversationId: string }
    Body: unknown
  }>(
    '/:conversationId/messages',
    {
      preHandler: [...preAuth, rateLimitMsgSend],
      schema: {
        tags: ['Conversations'],
        description: 'Send a message',
        params: {
          type: 'object',
          required: ['conversationId'],
          properties: { conversationId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { conversationId: string }
        Body: unknown
      }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const parsed = SendMessageSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const msg = await messagingService.sendMessage(
        userId,
        request.params.conversationId,
        parsed.data,
      )
      return reply.code(201).send({ message: msg })
    },
  )

  app.delete<{ Params: { conversationId: string } }>(
    '/:conversationId/history',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Conversations'],
        description: 'Clear chat history for current user',
        params: {
          type: 'object',
          required: ['conversationId'],
          properties: { conversationId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { conversationId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      await messagingService.clearChatHistory(
        userId,
        request.params.conversationId,
      )
      return reply.code(204).send()
    },
  )

  app.post<{
    Params: { conversationId: string }
    Body: unknown
  }>(
    '/:conversationId/mute',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Conversations'],
        description: 'Mute or unmute conversation',
        params: {
          type: 'object',
          required: ['conversationId'],
          properties: { conversationId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { conversationId: string }
        Body: unknown
      }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const parsed = MuteConversationSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      await messagingService.muteConversation(
        userId,
        request.params.conversationId,
        parsed.data.mutedUntil,
      )
      return reply.send({ success: true })
    },
  )
}
