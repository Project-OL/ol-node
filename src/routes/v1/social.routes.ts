import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { socialRateLimits } from '../../middlewares/rateLimitAuth'
import {
  followParamSchema,
  visitParamSchema,
  socialCursorQuerySchema,
  userIdParamSchema,
} from '../../models/schemas'
import { followService } from '../../services/follow.service'
import { visitorService } from '../../services/visitor.service'
import { AppError } from '../../middlewares/errorHandler'

export default async function socialRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.post<{ Params: { targetUserId: string } }>(
    '/follow/:targetUserId',
    {
      preHandler: [...preAuth, socialRateLimits.follow],
      schema: {
        tags: ['Social'],
        description: 'Follow a user by targetUserId',
        params: {
          type: 'object',
          required: ['targetUserId'],
          properties: {
            targetUserId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { targetUserId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const parsed = followParamSchema.safeParse(request.params)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid target user id',
          'INVALID_REQUEST',
        )
      }
      const result = await followService.follow(
        userId,
        parsed.data.targetUserId,
        {
          request: {
            ip: request.ip,
            headers: request.headers as Record<string, string | undefined>,
          },
          deviceId: request.deviceId ?? null,
        },
      )
      return reply.status(200).send(result)
    },
  )

  app.delete<{ Params: { targetUserId: string } }>(
    '/follow/:targetUserId',
    {
      preHandler: [...preAuth, socialRateLimits.follow],
      schema: {
        tags: ['Social'],
        description: 'Unfollow a user by targetUserId',
        params: {
          type: 'object',
          required: ['targetUserId'],
          properties: {
            targetUserId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { targetUserId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const parsed = followParamSchema.safeParse(request.params)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid target user id',
          'INVALID_REQUEST',
        )
      }
      await followService.unfollow(
        userId,
        parsed.data.targetUserId,
        {
          request: {
            ip: request.ip,
            headers: request.headers as Record<string, string | undefined>,
          },
          deviceId: request.deviceId ?? null,
        },
      )
      return reply.status(200).send({ following: false })
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/followers',
    {
      preHandler: [...preAuth, socialRateLimits.list],
      schema: {
        tags: ['Social'],
        description: 'List followers for current user',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = socialCursorQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const { cursor, limit } = parsed.data
      const result = await followService.getFollowers(userId, userId, cursor ?? null, limit)
      return reply.status(200).send(result)
    },
  )

  app.get(
    '/following',
    {
      preHandler: [...preAuth, socialRateLimits.list],
      schema: {
        tags: ['Social'],
        description: 'List users the current user is following',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = socialCursorQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const { cursor, limit } = parsed.data
      const result = await followService.getFollowing(userId, userId, cursor ?? null, limit)
      return reply.status(200).send(result)
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/friends',
    {
      preHandler: [...preAuth, socialRateLimits.list],
      schema: {
        tags: ['Social'],
        description: 'List mutual followers (friends) for current user',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = socialCursorQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const { cursor, limit } = parsed.data
      const result = await followService.getFriends(userId, userId, cursor ?? null, limit)
      return reply.status(200).send(result)
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/counts/:userId',
    {
      preHandler: [...preAuth, socialRateLimits.list],
      schema: {
        tags: ['Social'],
        description: 'Get social counts for a user',
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
      const parsed = userIdParamSchema.safeParse(request.params)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid user id',
          'INVALID_REQUEST',
        )
      }
      const result = await followService.getCounts(parsed.data.userId)
      return reply.status(200).send(result)
    },
  )

  app.post<{ Params: { profileId: string } }>(
    '/visit/:profileId',
    {
      preHandler: [...preAuth, socialRateLimits.visit],
      schema: {
        tags: ['Social'],
        description: 'Record a profile visit',
        params: {
          type: 'object',
          required: ['profileId'],
          properties: { profileId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { profileId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const parsed = visitParamSchema.safeParse(request.params)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid profile id',
          'INVALID_REQUEST',
        )
      }
      await visitorService.recordVisit(parsed.data.profileId, userId, {
        request: {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        },
        deviceId: request.deviceId ?? null,
      })
      return reply.status(204).send()
    },
  )

  app.get(
    '/visitors',
    {
      preHandler: [...preAuth, socialRateLimits.list],
      schema: {
        tags: ['Social'],
        description: 'List recent visitors to current user profile',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = socialCursorQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const { cursor, limit } = parsed.data
      const result = await visitorService.getVisitors(userId, cursor ?? null, limit)
      return reply.status(200).send(result)
    },
  )

  app.get(
    '/visit-history',
    {
      preHandler: [...preAuth, socialRateLimits.list],
      schema: {
        tags: ['Social'],
        description: 'List profiles visited by current user',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = socialCursorQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const { cursor, limit } = parsed.data
      const result = await visitorService.getVisitHistory(userId, cursor ?? null, limit)
      return reply.status(200).send(result)
    },
  )
}

