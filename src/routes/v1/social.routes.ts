import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { socialRateLimits } from '../../middlewares/rateLimitAuth'
import { visitParamSchema, socialCursorQuerySchema } from '../../models/schemas'
import { followService } from '../../services/follow.service'
import { visitorService } from '../../services/visitor.service'
import { userRepository } from '../../repositories/user.repository'
import { AppError } from '../../middlewares/errorHandler'

async function resolvePublicId(publicId: string): Promise<string> {
  const numericId = Number(publicId)
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
  }
  const user = await userRepository.findByPublicId(numericId)
  if (!user) {
    throw new AppError(404, 'User not found', 'NOT_FOUND')
  }
  return user.id
}

export default async function socialRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.post<{ Params: { publicId: string } }>(
    '/follow/:publicId',
    {
      preHandler: [...preAuth, socialRateLimits.follow],
      schema: {
        tags: ['Social'],
        description: 'Follow a user by publicId',
        params: {
          type: 'object',
          required: ['publicId'],
          properties: { publicId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
      const userId = request.userId!
      const targetUserId = await resolvePublicId(request.params.publicId)
      const result = await followService.follow(userId, targetUserId, {
        request: {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        },
        deviceId: request.deviceId ?? null,
      })
      return reply.status(200).send(result)
    },
  )

  app.delete<{ Params: { publicId: string } }>(
    '/follow/:publicId',
    {
      preHandler: [...preAuth, socialRateLimits.follow],
      schema: {
        tags: ['Social'],
        description: 'Unfollow a user by publicId',
        params: {
          type: 'object',
          required: ['publicId'],
          properties: { publicId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
      const userId = request.userId!
      const targetUserId = await resolvePublicId(request.params.publicId)
      await followService.unfollow(userId, targetUserId, {
        request: {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        },
        deviceId: request.deviceId ?? null,
      })
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

  app.get<{ Params: { publicId: string } }>(
    '/counts/:publicId',
    {
      preHandler: [...preAuth, socialRateLimits.list],
      schema: {
        tags: ['Social'],
        description: 'Get social counts (followers, following, friends) for a user by publicId',
        params: {
          type: 'object',
          required: ['publicId'],
          properties: { publicId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
      const targetUserId = await resolvePublicId(request.params.publicId)
      const result = await followService.getCounts(targetUserId)
      return reply.status(200).send(result)
    },
  )

  app.post<{ Params: { publicId: string } }>(
    '/visit/:publicId',
    {
      preHandler: [...preAuth, socialRateLimits.visit],
      schema: {
        tags: ['Social'],
        description: 'Record a profile visit by publicId',
        params: {
          type: 'object',
          required: ['publicId'],
          properties: { publicId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = visitParamSchema.safeParse({ profileId: request.params.publicId })
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid public ID',
          'INVALID_REQUEST',
        )
      }
      const profileId = await resolvePublicId(request.params.publicId)
      await visitorService.recordVisit(profileId, userId, {
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
