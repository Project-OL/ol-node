import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import {
  PushNotificationSchema,
  PushBroadcastSchema,
  ListPushUsersQuerySchema,
  ListPushDeliveriesQuerySchema,
} from '../../models/push-notification.schemas'
import { pushNotificationAdminService } from '../../services/pushNotificationAdmin.service'
import { parseRequest } from '../../utils/zod-request'

const preAuth = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

export default async function pushNotificationAdminRoutes(app: FastifyInstance) {
  app.get(
    '/notifications/push/users',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Push Notifications'],
        description:
          'Paginated list of users who have a registered FCM token (token value is never returned). Filter by country or search query.',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            country: { type: 'string' },
            q: { type: 'string' },
            activeOnly: { type: 'string', enum: ['true', 'false', '1', '0'] },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = parseRequest(ListPushUsersQuerySchema, request.query)
      const result = await pushNotificationAdminService.listUsersWithFcmToken(query)
      return reply.send(result)
    },
  )

  app.get(
    '/notifications/push/stats/today',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Push Notifications'],
        description:
          'UTC-day counters for FCM deliveries: sent, failed, skipped, plus breakdown by source.',
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await pushNotificationAdminService.getTodayStats()
      return reply.send(result)
    },
  )

  app.get(
    '/notifications/push/deliveries',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Push Notifications'],
        description:
          'Paginated delivery log with notification payload + user detail. Default filters to today (UTC). Use status=FAILED for failures.',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: { type: 'string', enum: ['SENT', 'FAILED', 'SKIPPED'] },
            source: {
              type: 'string',
              enum: ['ADMIN_SINGLE', 'ADMIN_BROADCAST', 'TRANSACTION', 'NEW_MESSAGE'],
            },
            campaignId: { type: 'string' },
            todayOnly: { type: 'string', enum: ['true', 'false', '1', '0'] },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = parseRequest(ListPushDeliveriesQuerySchema, request.query)
      const result = await pushNotificationAdminService.listDeliveries(query)
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string }; Body: unknown }>(
    '/notifications/push/user/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Push Notifications'],
        description: 'Send an FCM push notification to one user, synchronously.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { userId: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = PushNotificationSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const result = await pushNotificationAdminService.sendToUser({
        adminUserId,
        targetUserId: request.params.userId,
        title: parsed.data.title,
        body: parsed.data.body,
        data: parsed.data.data,
      })
      return reply.send(result)
    },
  )

  app.post<{ Body: unknown }>(
    '/notifications/push/broadcast',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Push Notifications'],
        description:
          'Queue an FCM push to many users: explicit userIds, a country segment, or all active users with a registered token when neither is given.',
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = PushBroadcastSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const result = await pushNotificationAdminService.broadcast({
        adminUserId,
        title: parsed.data.title,
        body: parsed.data.body,
        data: parsed.data.data,
        userIds: parsed.data.userIds,
        country: parsed.data.country,
      })
      return reply.send(result)
    },
  )
}
