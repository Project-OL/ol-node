import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminPostListQuerySchema,
  adminPostWarnBodySchema,
  adminPostingSuspendBodySchema,
} from '../../models/admin-user-wallet.schemas'
import { adminPostService } from '../../services/adminPost.service'

const preAuth = [authenticateAdmin]

export default async function postAdminRoutes(app: FastifyInstance) {
  app.get(
    '/posts',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Posts'],
        description: 'List posts for a user (admin moderation).',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminPostListQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await adminPostService.listUserPosts(
        parsed.data.userId,
        parsed.data.cursor ?? null,
        parsed.data.limit,
      )
      return reply.send(result)
    },
  )

  app.get<{ Params: { postId: string } }>(
    '/posts/:postId',
    {
      preHandler: preAuth,
      schema: { tags: ['Admin', 'Posts'], description: 'Post detail for admin moderation.' },
    },
    async (request, reply) => {
      return reply.send(await adminPostService.getPostDetail(request.params.postId))
    },
  )

  app.delete<{ Params: { postId: string } }>(
    '/posts/:postId',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Posts'] } },
    async (request, reply) => {
      await adminPostService.deletePost(request.params.postId, request.adminUser!.id, {
        request: { ip: request.ip, headers: request.headers as Record<string, string | undefined> },
        deviceId: request.headers['x-device-id'] as string | undefined,
      })
      return reply.status(204).send()
    },
  )

  app.post<{ Params: { postId: string } }>(
    '/posts/:postId/warn',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Posts'] } },
    async (request, reply) => {
      const parsed = adminPostWarnBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminPostService.warnPostAuthor({
          postId: request.params.postId,
          adminUserId: request.adminUser!.id,
          message: parsed.data.message,
        }),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/posting/suspend',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Posts'] } },
    async (request, reply) => {
      const parsed = adminPostingSuspendBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminPostService.suspendPosting(
          request.params.userId,
          new Date(parsed.data.suspendedUntil),
          request.adminUser!.id,
        ),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/posting/ban',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Posts'] } },
    async (request, reply) => {
      return reply.send(
        await adminPostService.banPosting(request.params.userId, request.adminUser!.id),
      )
    },
  )

  /** Preferred name for clearing ban/suspension (alias of `/posting/restore`). */
  app.post<{ Params: { userId: string } }>(
    '/users/:userId/posting/activate',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Posts'],
        description: 'Re-enable posting after a ban or timed suspension.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminPostService.restorePosting(request.params.userId, request.adminUser!.id),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/posting/restore',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Posts'],
        description: 'Alias of `/posting/activate` — clear ban + suspension.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminPostService.restorePosting(request.params.userId, request.adminUser!.id),
      )
    },
  )
}
