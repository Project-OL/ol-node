import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import crypto from 'crypto'
import { z } from 'zod'
import { VipMembershipTier } from '@prisma/client'
import { authenticate } from '../../middlewares/auth.middleware'
import { rateLimitVipmClaim, rateLimitVipmPurchase } from '../../middlewares/rateLimitAuth'
import { AppError } from '../../middlewares/errorHandler'
import { vipMembershipService } from '../../services/vip-membership.service'

const preAuth = [authenticate]

const PurchaseBodySchema = z.object({
  tier: z.nativeEnum(VipMembershipTier),
})

export default async function vipMembershipRoutes(app: FastifyInstance) {
  app.get(
    '/me',
    {
      preHandler: preAuth,
      schema: {
        tags: ['VIP Membership'],
        description: 'Current paid VIP membership (Diamond/SVIP) — separate from VIP public ID',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const data = await vipMembershipService.getMembership(userId)
      return reply.send(data)
    },
  )

  app.get(
    '/config',
    {
      preHandler: preAuth,
      schema: {
        tags: ['VIP Membership'],
        description: 'Tier pricing and limits for paid VIP membership',
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(vipMembershipService.getPublicConfig())
    },
  )

  app.post(
    '/purchase',
    {
      preHandler: [...preAuth, rateLimitVipmPurchase],
      schema: {
        tags: ['VIP Membership'],
        description: 'Purchase or stack Diamond / SVIP membership (coin debit)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const parsed = PurchaseBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const idempotencyKey = `vip-membership-purchase:${userId}:${crypto.randomUUID()}`
      const body = await vipMembershipService.purchase(userId, parsed.data.tier, idempotencyKey)
      return reply.status(201).send({
        tier: body.tier,
        coinsPaid: body.coinsPaid,
        expiresAt: body.expiresAt.toISOString(),
      })
    },
  )

  app.post(
    '/claim-daily',
    {
      preHandler: [...preAuth, rateLimitVipmClaim],
      schema: {
        tags: ['VIP Membership'],
        description: 'Claim daily VIP coin grant (idempotent per UTC day)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const body = await vipMembershipService.claimDaily(userId)
      return reply.send(body)
    },
  )

  app.get(
    '/purchase-history',
    {
      preHandler: preAuth,
      schema: {
        tags: ['VIP Membership'],
        description: 'Recent VIP membership purchases (cursor pagination)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const q = request.query as { limit?: string; cursor?: string }
      const limit = Math.min(50, Math.max(1, Number(q.limit ?? 20) || 20))
      const cursor = q.cursor?.trim() || null
      const data = await vipMembershipService.getPurchaseHistory(userId, {
        limit,
        cursor,
      })
      return reply.send(data)
    },
  )
}
