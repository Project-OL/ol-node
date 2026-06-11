import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../../middlewares/auth.middleware'
import {
  perUserRateLimit,
  subscriptionFeedRateLimit,
  subscriptionTopCreatorsRateLimit,
} from '../../middlewares/rateLimitAuth'
import { AppError } from '../../middlewares/errorHandler'
import { subscriptionService } from '../../services/subscription.service'

const createBodySchema = z.object({
  creatorId: z.string().min(1),
})

const checkQuerySchema = z.object({
  subscriberId: z.string().min(1),
  creatorId: z.string().min(1),
})

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
})

const mutatePre = [authenticate, perUserRateLimit]

export default async function subscriptionRoutes(app: FastifyInstance) {
  app.get(
    '/check',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Subscriptions'],
        description:
          'Check if subscriberId currently has an active paid subscription to creatorId.',
        querystring: {
          type: 'object',
          required: ['subscriberId', 'creatorId'],
          properties: {
            subscriberId: { type: 'string', minLength: 1 },
            creatorId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = checkQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const isSubscribed = await subscriptionService.isSubscribed(
        parsed.data.subscriberId,
        parsed.data.creatorId,
      )
      return reply.status(200).send({ isSubscribed })
    },
  )

  app.get(
    '/my-subscriptions',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Subscriptions'],
        description: 'List users the current user is actively subscribed to.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const items = await subscriptionService.listMySubscriptions(userId)
      return reply.status(200).send({ items })
    },
  )

  app.get(
    '/status',
    {
      preHandler: [authenticate, perUserRateLimit],
      schema: {
        tags: ['Subscriptions'],
        description: 'Whether the caller has any ACTIVE paid subscriptions and how many.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const result = await subscriptionService.getSubscriptionStatus(userId)
      return reply.status(200).send(result)
    },
  )

  app.get(
    '/top-creators',
    {
      preHandler: [authenticate, subscriptionTopCreatorsRateLimit],
      schema: {
        tags: ['Subscriptions'],
        description:
          'Top creators for discovery: country by ACTIVE subscriber count (when profile country is set), then app-wide subscribers, then app-wide post count (excludes caller, max 3).',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const result = await subscriptionService.getTopCreatorsByCountry(userId)
      return reply.status(200).send(result)
    },
  )

  app.get(
    '/feed',
    {
      preHandler: [authenticate, subscriptionFeedRateLimit],
      schema: {
        tags: ['Subscriptions'],
        description: 'Paginated post feed from all creators the caller actively subscribes to.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const parsed = feedQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await subscriptionService.getSubscriptionFeed(
        userId,
        parsed.data.limit,
        parsed.data.cursor,
      )
      return reply.status(200).send(result)
    },
  )

  app.get(
    '/my-subscribers',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Subscriptions'],
        description: 'List users who are actively subscribed to the current user.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const items = await subscriptionService.listMySubscribers(userId)
      return reply.status(200).send({ items })
    },
  )

  app.post(
    '/',
    {
      preHandler: mutatePre,
      schema: {
        tags: ['Subscriptions'],
        description:
          'Subscribe to a creator (debits coins, starts 30-day renewal schedule). Duplicate active subscription returns 409.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const subscriberId = request.userId
      if (!subscriberId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const parsed = createBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const row = await subscriptionService.createSubscription(subscriberId, parsed.data.creatorId)
      return reply.status(201).send({
        subscription: {
          id: row.id,
          creatorId: row.creatorId,
          status: row.status,
          nextRenewalAt: row.nextRenewalAt,
        },
      })
    },
  )

  app.delete<{ Params: { creatorId: string } }>(
    '/:creatorId',
    {
      preHandler: mutatePre,
      schema: {
        tags: ['Subscriptions'],
        description: 'Cancel paid subscription to a creator (stops renewals, removes access).',
        params: {
          type: 'object',
          required: ['creatorId'],
          properties: { creatorId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { creatorId: string } }>, reply: FastifyReply) => {
      const subscriberId = request.userId
      if (!subscriberId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const { creatorId } = request.params
      await subscriptionService.cancelSubscription(subscriberId, creatorId)
      return reply.status(204).send()
    },
  )
}
