import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { accountDeletionRateLimits } from '../../middlewares/rateLimitAuth'
import {
  scheduleDeletionSchema,
  cancelDeletionSchema,
} from '../../models/account-deletion.schemas'
import { accountDeletionService } from '../../services/account-deletion.service'
import { AppError } from '../../middlewares/errorHandler'

export default async function accountDeletionRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.post(
    '/schedule-deletion',
    {
      preHandler: [preAuth, accountDeletionRateLimits.scheduleDeletion].flat(),
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = scheduleDeletionSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
          { fieldErrors: body.error.flatten().fieldErrors },
        )
      }
      const result = await accountDeletionService.scheduleDeletion(
        userId,
        body.data.securityPassword,
        body.data.reason,
        (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip,
      )
      return reply.status(201).send({ data: result })
    },
  )

  app.get(
    '/deletion-status',
    {
      preHandler: [preAuth, accountDeletionRateLimits.deletionStatus].flat(),
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const result = await accountDeletionService.getDeletionStatus(userId)
      return reply.status(200).send({ data: result })
    },
  )

  app.post(
    '/cancel-deletion',
    {
      preHandler: [preAuth, accountDeletionRateLimits.cancelDeletion].flat(),
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = cancelDeletionSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
          { fieldErrors: body.error.flatten().fieldErrors },
        )
      }
      const result = await accountDeletionService.cancelDeletion(
        userId,
        body.data.securityPassword,
      )
      return reply.status(200).send({ data: result })
    },
  )
}
