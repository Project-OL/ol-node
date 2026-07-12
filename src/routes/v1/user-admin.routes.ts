import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { adminUserTagsBodySchema } from '../../models/admin-user-tags.schemas'
import { adminUserSearchQuerySchema } from '../../models/admin-user-search.schemas'
import { adminUserPatchBodySchema } from '../../models/admin-user-detail.schemas'
import { adminUserTagsService } from '../../services/admin-user-tags.service'
import { adminUserSearchService } from '../../services/adminUserSearch.service'
import { adminUserDetailService } from '../../services/adminUserDetail.service'
import { storeAdminService } from '../../services/store-admin.service'

const preAuth = [authenticateAdmin]

export default async function userAdminRoutes(app: FastifyInstance) {
  app.get(
    '/users/search',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Search users by name, user id (UUID), public id, email, phone (E.164), or device id. Use `type=auto` (default) or force a field.',
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 255 },
            type: {
              type: 'string',
              enum: ['auto', 'name', 'userId', 'publicId', 'email', 'phone', 'deviceId'],
            },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            includeStore: { type: 'boolean' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminUserSearchQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await adminUserSearchService.search(parsed.data)
      return reply.send(result)
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description: 'Full user profile for admin (identity, VIP, agency, device, status).',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      return reply.send(await adminUserDetailService.getUserDetail(request.params.userId))
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/store-items',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Store'],
        description: 'User-owned store items and currently equipped cosmetics.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      return reply.send(await storeAdminService.getUserStoreSummary(request.params.userId))
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/wallet',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Wallet'],
        description: 'User wallet balances and lifetime recharge / withdrawal totals.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      return reply.send(await adminUserDetailService.getUserWallet(request.params.userId))
    },
  )

  app.patch<{ Params: { userId: string } }>(
    '/users/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Update user profile fields and status (active / suspend N days / ban). Revokes sessions on status change.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminUserPatchBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const result = await adminUserDetailService.updateUser(request.params.userId, parsed.data)
      return reply.send(result)
    },
  )

  app.put<{ Params: { userId: string } }>(
    '/users/:userId/tags',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Replace platform-admin tags for a user (max 20, each max 50 chars). Visible on GET /users/me and GET /users/search.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
        body: {
          type: 'object',
          required: ['tags'],
          properties: {
            tags: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 50 },
              maxItems: 20,
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminUserTagsBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }

      const result = await adminUserTagsService.setTags(request.params.userId, parsed.data.tags)
      return reply.send(result)
    },
  )
}
