import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { requireAdmin } from '../../middlewares/requireAdmin'
import { adminUserTagsBodySchema } from '../../models/admin-user-tags.schemas'
import { adminUserTagsService } from '../../services/admin-user-tags.service'

const preAuth = [requireAdmin]

export default async function userAdminRoutes(app: FastifyInstance) {
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

      const result = await adminUserTagsService.setTags(
        request.params.userId,
        parsed.data.tags,
      )
      return reply.send(result)
    },
  )
}
