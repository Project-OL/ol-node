import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { requireAdmin } from '../../middlewares/requireAdmin'
import { superHostTargetParamsSchema } from '../../models/super-host.schemas'
import { superHostService } from '../../services/super-host.service'

const preAuth = [requireAdmin]

export default async function superHostRoutes(app: FastifyInstance) {
  app.post<{ Params: { targetUserId: string } }>(
    '/super-host/:targetUserId/grant',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'SuperHost'],
        description: 'Grant super-host status to a target user (admin only).',
        params: {
          type: 'object',
          required: ['targetUserId'],
          properties: { targetUserId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { targetUserId: string } }>,
      reply: FastifyReply,
    ) => {
      const adminUserId = request.userId
      if (!adminUserId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }

      const parsed = superHostTargetParamsSchema.safeParse(request.params)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid params',
          'INVALID_REQUEST',
        )
      }

      await superHostService.grantSuperHost(adminUserId, parsed.data.targetUserId)
      return reply.status(204).send()
    },
  )

  app.delete<{ Params: { targetUserId: string } }>(
    '/super-host/:targetUserId/revoke',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'SuperHost'],
        description: 'Revoke super-host status from a target user (admin only).',
        params: {
          type: 'object',
          required: ['targetUserId'],
          properties: { targetUserId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { targetUserId: string } }>,
      reply: FastifyReply,
    ) => {
      const adminUserId = request.userId
      if (!adminUserId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }

      const parsed = superHostTargetParamsSchema.safeParse(request.params)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid params',
          'INVALID_REQUEST',
        )
      }

      await superHostService.revokeSuperHost(adminUserId, parsed.data.targetUserId)
      return reply.status(204).send()
    },
  )
}
