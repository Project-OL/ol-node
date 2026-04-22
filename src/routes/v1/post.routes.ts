import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { socialRateLimits } from '../../middlewares/rateLimitAuth'
import {
  postUploadUrlSchema,
  createPostSchema,
  likeParamSchema,
  tagSearchQuerySchema,
  postCursorQuerySchema,
} from '../../models/schemas'
import { postService } from '../../services/post.service'
import { AppError } from '../../middlewares/errorHandler'

export default async function postRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.post(
    '/upload-url',
    {
      preHandler: [...preAuth, socialRateLimits.postUploadUrl],
      schema: {
        tags: ['Posts'],
        description: 'Generate a presigned URL for uploading post media',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const parsed = postUploadUrlSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }

      const {
        fileName,
        mimeType,
        durationSeconds,
        sizeBytes,
      } = parsed.data
      const result = await postService.generateUploadUrl(
        userId,
        fileName,
        mimeType,
        durationSeconds,
        sizeBytes,
      )
      return reply.status(200).send(result)
    },
  )

  app.post(
    '/',
    {
      preHandler: [...preAuth, socialRateLimits.postCreate],
      schema: {
        tags: ['Posts'],
        description: 'Create a new post after uploading media',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const parsed = createPostSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }

      const dto = parsed.data

      const post = await postService.createPost(userId, dto, {
        request: {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        },
        deviceId: request.deviceId ?? null,
      })

      return reply.status(201).send({ post })
    },
  )

  app.get<{ Params: { userId: string }; Querystring: { cursor?: string; limit?: number } }>(
    '/user/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Posts'],
        description: 'Get posts for a specific user with cursor-based pagination',
        params: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { userId: string }
        Querystring: { cursor?: string; limit?: number }
      }>,
      reply: FastifyReply,
    ) => {
      const requesterId = request.userId
      if (!requesterId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const params = request.params
      if (!params.userId) {
        throw new AppError(400, 'Invalid user id', 'INVALID_REQUEST')
      }

      const parsedQuery = postCursorQuerySchema.safeParse(request.query ?? {})
      if (!parsedQuery.success) {
        throw new AppError(
          400,
          parsedQuery.error.errors[0]?.message ?? 'Invalid query parameters',
          'INVALID_REQUEST',
        )
      }

      const { cursor, limit } = parsedQuery.data

      const result = await postService.getPostsByUser(params.userId, requesterId, cursor ?? null, limit)
      return reply.status(200).send(result)
    },
  )

  app.get(
    '/tags/search',
    {
      preHandler: [...preAuth, socialRateLimits.tagSearch],
      schema: {
        tags: ['Posts'],
        description: 'Search within users the requester follows for @tag suggestions',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requesterId = request.userId
      if (!requesterId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }

      const parsed = tagSearchQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }

      const users = await postService.searchTaggableUsers(requesterId, parsed.data.query)
      return reply.status(200).send({ users })
    },
  )

  app.get<{ Params: { postId: string } }>(
    '/:postId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Posts'],
        description: 'Get a single post by id',
        params: {
          type: 'object',
          required: ['postId'],
          properties: {
            postId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { postId: string } }>, reply: FastifyReply) => {
      const requesterId = request.userId
      if (!requesterId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const { postId } = request.params
      if (!postId) {
        throw new AppError(400, 'Invalid post id', 'INVALID_REQUEST')
      }

      const post = await postService.getPost(postId, requesterId)
      return reply.status(200).send({ post })
    },
  )

  app.delete<{ Params: { postId: string } }>(
    '/:postId',
    {
      preHandler: [...preAuth, socialRateLimits.postDelete],
      schema: {
        tags: ['Posts'],
        description: 'Delete a post owned by the current user',
        params: {
          type: 'object',
          required: ['postId'],
          properties: {
            postId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { postId: string } }>, reply: FastifyReply) => {
      const requesterId = request.userId
      if (!requesterId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      const { postId } = request.params
      if (!postId) {
        throw new AppError(400, 'Invalid post id', 'INVALID_REQUEST')
      }

      await postService.deletePost(postId, requesterId, {
        request: {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        },
        deviceId: request.deviceId ?? null,
      })

      return reply.status(204).send()
    },
  )

  app.post<{ Params: { postId: string } }>(
    '/:postId/like',
    {
      preHandler: [...preAuth, socialRateLimits.postLike],
      schema: {
        tags: ['Posts'],
        description: 'Like a post',
        params: {
          type: 'object',
          required: ['postId'],
          properties: {
            postId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { postId: string } }>, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }

      const parsed = likeParamSchema.safeParse(request.params)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid post id',
          'INVALID_REQUEST',
        )
      }

      const { likesCount, isLiked } = await postService.likePost(parsed.data.postId, userId, {
        request: {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        },
        deviceId: request.deviceId ?? null,
      })

      return reply.status(200).send({ likesCount, isLiked })
    },
  )

  app.delete<{ Params: { postId: string } }>(
    '/:postId/like',
    {
      preHandler: [...preAuth, socialRateLimits.postLike],
      schema: {
        tags: ['Posts'],
        description: 'Unlike a post',
        params: {
          type: 'object',
          required: ['postId'],
          properties: {
            postId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { postId: string } }>, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }

      const parsed = likeParamSchema.safeParse(request.params)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid post id',
          'INVALID_REQUEST',
        )
      }

      const { likesCount, isLiked } = await postService.unlikePost(parsed.data.postId, userId, {
        request: {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        },
        deviceId: request.deviceId ?? null,
      })

      return reply.status(200).send({ likesCount, isLiked })
    },
  )
}

