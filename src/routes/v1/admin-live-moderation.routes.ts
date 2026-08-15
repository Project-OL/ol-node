import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminLiveModerationListQuerySchema,
  adminUserLiveModerationQuerySchema,
} from '../../models/admin-live-moderation.schemas'
import {
  adminListActiveLiveStreamsQuerySchema,
  adminStopLiveStreamBodySchema,
} from '../../models/admin-user-restriction.schemas'
import { adminLiveModerationService } from '../../services/adminLiveModeration.service'
import { adminLiveStreamService } from '../../services/adminLiveStream.service'

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

  app.get(
    '/live-streams/active',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Live', 'Moderation'],
        description: 'List all currently open live streams (optional hostUserId filter).',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminListActiveLiveStreamsQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(await adminLiveStreamService.listActiveGlobal(parsed.data))
    },
  )

  app.post<{ Params: { streamRef: string } }>(
    '/live-streams/:streamRef/stop',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Live', 'Moderation'],
        description:
          'Stop any open live stream by room id or DB id. Resolves the host, then LiveKit deleteRoom + Redis cleanup.',
      },
    },
    async (request, reply) => {
      const parsed = adminStopLiveStreamBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminLiveStreamService.requestStopByRef({
          streamRef: request.params.streamRef,
          adminUserId: request.adminUser!.id,
          reason: parsed.data.reason,
        }),
      )
    },
  )
}
