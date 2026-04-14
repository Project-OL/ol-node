import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { guardianPurchaseRateLimit } from '../../middlewares/rateLimitAuth'
import { AppError } from '../../middlewares/errorHandler'
import { PurchaseGuardianSchema } from '../../models/guardian.schemas'
import { guardianService } from '../../services/guardian.service'

const preAuth = [authenticate]

export default async function guardianRoutes(app: FastifyInstance) {
  app.get(
    '/config',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Guardian'],
        description: 'Static tier × duration pricing for guardian purchases',
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(guardianService.getGuardianConfig())
    },
  )

  app.post(
    '/',
    {
      preHandler: [...preAuth, guardianPurchaseRateLimit],
      schema: {
        tags: ['Guardian'],
        description: 'Purchase / renew guardian for a target user (coins debited upfront)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const parsed = PurchaseGuardianSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const body = await guardianService.purchaseGuardian(userId, parsed.data)
      return reply.status(201).send({
        guardianId: body.guardianId,
        tier: body.tier,
        durationMonths: body.durationMonths,
        coinsPaid: body.coinsPaid,
        expiresAt: body.expiresAt.toISOString(),
        daysRemaining: body.daysRemaining,
      })
    },
  )

  app.get(
    '/my-guardians',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Guardian'],
        description: 'Active guardianships where I am the guardian',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const items = await guardianService.getMyGuardians(userId)
      return reply.send({ items })
    },
  )

  app.get(
    '/guarding-me',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Guardian'],
        description: 'Active guardians where I am the target',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const items = await guardianService.getGuardiansOfMe(userId)
      return reply.send({ items })
    },
  )

  app.get<{ Params: { targetUserId: string } }>(
    '/active/:targetUserId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Guardian'],
        description: 'Top active guardian for profile card (null → 204)',
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
      const active = await guardianService.getActiveGuardian(request.params.targetUserId)
      if (!active) {
        return reply.status(204).send()
      }
      return reply.send(active)
    },
  )
}
