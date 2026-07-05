import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  platformMessageBodySchema,
  platformNotificationBroadcastBodySchema,
} from '../../models/platform-message.schemas'
import { adminMessagingService } from '../../services/adminMessaging.service'

const preAuth = [authenticateAdmin]

export default async function platformMessageAdminRoutes(app: FastifyInstance) {
  app.post<{ Params: { userId: string } }>(
    '/users/:userId/messages/system',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Messaging'],
        description:
          'Send a SYSTEM platform message to the user support chat (appears in their platform conversation).',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = platformMessageBodySchema.parse(request.body ?? {})
      const result = await adminMessagingService.sendSystemMessage({
        targetUserId: request.params.userId,
        adminUserId,
        message: body.message,
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/messages/notification',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Messaging'],
        description:
          'Send a NOTIFICATION platform message to one user support chat.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = platformMessageBodySchema.parse(request.body ?? {})
      const result = await adminMessagingService.sendNotificationMessage({
        targetUserId: request.params.userId,
        adminUserId,
        message: body.message,
      })
      return reply.send(result)
    },
  )

  app.post(
    '/messages/notifications/broadcast',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Messaging'],
        description:
          'Queue NOTIFICATION messages to many users (or all active users when userIds omitted).',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = platformNotificationBroadcastBodySchema.parse(request.body ?? {})
      const result = await adminMessagingService.broadcastNotificationMessage({
        adminUserId,
        message: body.message,
        userIds: body.userIds,
        campaignId: body.campaignId,
      })
      return reply.send(result)
    },
  )
}
