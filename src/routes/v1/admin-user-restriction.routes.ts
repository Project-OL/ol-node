import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminApplyRestrictionBodySchema,
  adminListGlobalRestrictionsQuerySchema,
  adminListRestrictionsQuerySchema,
  adminStopLiveStreamBodySchema,
  userRestrictionTypeSchema,
} from '../../models/admin-user-restriction.schemas'
import { userRestrictionService } from '../../services/userRestriction.service'
import { adminLiveStreamService } from '../../services/adminLiveStream.service'

const preAuth = [authenticateAdmin]

export default async function adminUserRestrictionRoutes(app: FastifyInstance) {
  app.get(
    '/restrictions',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Moderation'],
        description:
          'Global list of timed restrictions (chat mute, audio mute, messaging disable, live-start ban).',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminListGlobalRestrictionsQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(await userRestrictionService.listGlobalForAdmin(parsed.data))
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/restrictions',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Moderation'],
        description:
          'List timed user restrictions (live chat mute, live audio mute, messaging disable, live-start ban).',
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminListRestrictionsQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await userRestrictionService.listForAdmin(
          request.params.userId,
          parsed.data.includeCleared ?? false,
        ),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/restrictions',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Moderation'],
        description:
          'Apply one restriction type until restrictedUntil. For MESSAGING_DISABLE, optional targetUserIds limits the ban to those recipients; extend:true unions targets and keeps the later expiry. Other types are unchanged. Optional reportId links to a user report.',
      },
    },
    async (request, reply) => {
      const parsed = adminApplyRestrictionBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await userRestrictionService.apply({
          userId: request.params.userId,
          type: parsed.data.type,
          restrictedUntil: new Date(parsed.data.restrictedUntil),
          reason: parsed.data.reason,
          reportId: parsed.data.reportId,
          adminUserId: request.adminUser!.id,
          targetUserIds: parsed.data.targetUserIds,
          extend: parsed.data.extend,
        }),
      )
    },
  )

  app.delete<{ Params: { userId: string; restrictionId: string } }>(
    '/users/:userId/restrictions/:restrictionId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Moderation'],
        description: 'Clear a specific restriction row early.',
      },
    },
    async (request, reply) => {
      const row = await userRestrictionService.clearById({
        restrictionId: request.params.restrictionId,
        adminUserId: request.adminUser!.id,
      })
      if (row.userId !== request.params.userId) {
        throw new AppError(404, 'Restriction not found', 'RESTRICTION_NOT_FOUND')
      }
      return reply.send(row)
    },
  )

  app.post<{ Params: { userId: string; type: string } }>(
    '/users/:userId/restrictions/:type/clear',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Moderation'],
        description: 'Clear all active restrictions of this type for the user.',
      },
    },
    async (request, reply) => {
      const typeParsed = userRestrictionTypeSchema.safeParse(request.params.type)
      if (!typeParsed.success) {
        throw new AppError(400, 'Invalid restriction type', 'INVALID_REQUEST')
      }
      return reply.send(
        await userRestrictionService.clearType({
          userId: request.params.userId,
          type: typeParsed.data,
          adminUserId: request.adminUser!.id,
        }),
      )
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/live-streams/active',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Live'],
        description:
          'List ongoing live streams for a user (host_live_sessions + live_streams + Redis).',
      },
    },
    async (request, reply) => {
      return reply.send(await adminLiveStreamService.listActiveForUser(request.params.userId))
    },
  )

  app.post<{ Params: { userId: string; streamRef: string } }>(
    '/users/:userId/live-streams/:streamRef/stop',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Live'],
        description:
          'Stop an ongoing live stream: LiveKit deleteRoom (disconnect host and viewers), end live_streams + agency session, clear livestream Redis keys. No Live-server change required.',
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
        await adminLiveStreamService.requestStop({
          userId: request.params.userId,
          streamRef: request.params.streamRef,
          adminUserId: request.adminUser!.id,
          reason: parsed.data.reason,
        }),
      )
    },
  )
}
