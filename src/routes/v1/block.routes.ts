import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { rateLimitBlock } from '../../middlewares/rateLimitAuth'
import {
  BlockUserSchema,
  BulkUnblockSchema,
  GetBlockListSchema,
} from '../../models/messaging.schemas'
import { blockService } from '../../services/block.service'
import { AppError } from '../../middlewares/errorHandler'

export default async function blockRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.post<{ Body: unknown }>(
    '/',
    {
      preHandler: [...preAuth, rateLimitBlock],
      schema: {
        tags: ['Blocks'],
        description: 'Block a user',
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = BlockUserSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      await blockService.blockUser(userId, parsed.data.userId)
      return reply.code(201).send({ success: true })
    },
  )

  app.delete<{ Params: { userId: string } }>(
    '/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Blocks'],
        description: 'Unblock a user',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      reply: FastifyReply,
    ) => {
      const blockerId = request.userId!
      await blockService.unblockUser(blockerId, request.params.userId)
      return reply.code(204).send()
    },
  )

  app.post<{ Body: unknown }>(
    '/bulk-unblock',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Blocks'],
        description: 'Bulk unblock users',
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = BulkUnblockSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const result = await blockService.bulkUnblock(userId, parsed.data.userIds)
      return reply.send(result)
    },
  )

  app.get<{ Querystring: unknown }>(
    '/',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Blocks'],
        description: 'Get block list (searchable)',
      },
    },
    async (request: FastifyRequest<{ Querystring: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = GetBlockListSchema.safeParse(request.query)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await blockService.getBlockList(userId, parsed.data)
      return reply.send(result)
    },
  )
}
