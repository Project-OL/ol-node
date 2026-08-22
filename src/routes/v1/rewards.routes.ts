import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { rateLimitVipmClaim, rateLimitLivestreamRewardClaim } from '../../middlewares/rateLimitAuth'
import { AppError } from '../../middlewares/errorHandler'
import { rewardService } from '../../services/reward.service'
import { vipMembershipService } from '../../services/vip-membership.service'
import { livestreamRewardService } from '../../services/livestream-reward.service'
import { ClaimLivestreamRewardSchema } from '../../models/reward.schemas'

const preAuth = [authenticate]

export default async function rewardsRoutes(app: FastifyInstance) {
  app.get(
    '/',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Rewards'],
        description: 'List all rewards the current user can avail (VIP daily + livestream daily)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const data = await rewardService.listRewards(userId)
      return reply.send(data)
    },
  )

  app.post(
    '/vip/claim',
    {
      preHandler: [...preAuth, rateLimitVipmClaim],
      schema: {
        tags: ['Rewards'],
        description:
          'Claim daily VIP coin grant from the rewards surface (same claim as /vip-membership/claim-daily)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = await vipMembershipService.claimDaily(userId)
      return reply.send(body)
    },
  )

  app.post<{ Body: unknown }>(
    '/livestream/claim',
    {
      preHandler: [...preAuth, rateLimitLivestreamRewardClaim],
      schema: {
        tags: ['Rewards'],
        description:
          'Claim a livestream daily reward part (configurable points at 1hr and 2hr streamed today, first N days of membership only)',
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = ClaimLivestreamRewardSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const body = await livestreamRewardService.claimPart(userId, parsed.data.part)
      return reply.send(body)
    },
  )
}
