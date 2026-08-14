import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminLiveModerationListQuerySchema,
  adminUserLiveModerationQuerySchema,
} from '../../models/admin-live-moderation.schemas'
import { adminLiveModerationService } from '../../services/adminLiveModeration.service'

const preAuth = [authenticateAdmin]

export default async function adminLiveModerationRoutes(app: FastifyInstance) {
  app.get(
    '/live-moderation',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Live', 'Moderation'],
        description:
          'Global live/video-call nudity detections, host stream bans, and live-related user reports.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminLiveModerationListQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(await adminLiveModerationService.listGlobal(parsed.data))
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/live-moderation',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Live', 'Moderation'],
        description:
          'Per-user live nudity logs, video-call nudity logs, host stream bans, and live/user reports.',
      },
    },
    async (request, reply) => {
      const parsed = adminUserLiveModerationQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminLiveModerationService.getUserDossier(request.params.userId, parsed.data),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/host-stream-suspension/clear',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Live', 'Moderation'],
        description:
          'Clear users.suspended_until when it is a live-stream (nudity) host ban, not a full account suspension.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminLiveModerationService.clearHostStreamSuspension({
          userId: request.params.userId,
          adminUserId: request.adminUser!.id,
        }),
      )
    },
  )
}
