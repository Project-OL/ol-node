import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { searchQuerySchema } from '../../models/schemas'
import { userSearchService } from '../../services/userSearch.service'
import { AppError } from '../../middlewares/errorHandler'

export default async function usersRoutes(app: FastifyInstance) {
  app.get(
    '/search',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description: 'Search user by publicId',
        querystring: {
          type: 'object',
          required: ['publicId'],
          properties: {
            publicId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requesterId = request.userId!
      const parsed = searchQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid search query',
          'INVALID_REQUEST',
        )
      }
      const user = await userSearchService.searchByPublicId(
        parsed.data.publicId,
        requesterId,
      )
      if (!user) {
        throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      }
      return reply.status(200).send({ user })
    },
  )
}

