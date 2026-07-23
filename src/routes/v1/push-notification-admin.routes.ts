import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { PushNotificationSchema, PushBroadcastSchema } from '../../models/push-notification.schemas'
import { pushNotificationAdminService } from '../../services/pushNotificationAdmin.service'

const preAuth = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

export default async function pushNotificationAdminRoutes(app: FastifyInstance) {
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
