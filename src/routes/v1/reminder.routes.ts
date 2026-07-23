import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { SetBroadcastReminderSchema, SetLiveNotifySchema } from '../../models/messaging.schemas'
import { userSearchService } from '../../services/userSearch.service'
import { prisma } from '../../config/database'
import { AppError } from '../../middlewares/errorHandler'

export default async function reminderRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.post<{ Body: unknown }>(
    '/broadcast',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Reminders'],
        description: 'Set live broadcast reminder',
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = SetBroadcastReminderSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const creator = await userSearchService.searchByPublicId(parsed.data.creatorPublicId, userId)
      if (!creator) {
        throw new AppError(404, 'Creator not found', 'NOT_FOUND')
      }
      await prisma.broadcastReminder.upsert({
        where: {
          userId_creatorId: { userId, creatorId: creator.userId },
        },
        create: {
          userId,
          creatorId: creator.userId,
          remindAt: new Date(parsed.data.remindAt),
        },
        update: {
          remindAt: new Date(parsed.data.remindAt),
          isSent: false,
        },
      })
      return reply.code(201).send({ success: true })
    },
  )

  app.delete<{ Params: { creatorPublicId: string } }>(
    '/broadcast/:creatorPublicId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Reminders'],
        description: 'Delete broadcast reminder',
        params: {
          type: 'object',
          required: ['creatorPublicId'],
          properties: { creatorPublicId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { creatorPublicId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const creator = await userSearchService.searchByPublicId(
        request.params.creatorPublicId,
        userId,
      )
      if (!creator) {
        throw new AppError(404, 'Creator not found', 'NOT_FOUND')
      }
      await prisma.broadcastReminder.deleteMany({
        where: { userId, creatorId: creator.userId },
      })
      return reply.code(204).send()
    },
  )

  app.get(
    '/broadcast',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Reminders'],
        description: 'List my broadcast reminders',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const reminders = await prisma.broadcastReminder.findMany({
        where: {
          userId,
          isSent: false,
          remindAt: { gte: new Date() },
        },
        orderBy: { remindAt: 'asc' },
        take: 50,
        include: {
          creator: {
            select: {
              id: true,
              username: true,
              defaultPublicId: true,
            },
          },
        },
      })
      return reply.send({ reminders })
    },
  )

  app.put<{ Params: { creatorPublicId: string }; Body: unknown }>(
    '/live-notify/:creatorPublicId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Reminders'],
        description: 'Toggle "notify me whenever they go live" for a creator',
        params: {
          type: 'object',
          required: ['creatorPublicId'],
          properties: { creatorPublicId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { creatorPublicId: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const parsed = SetLiveNotifySchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const creator = await userSearchService.searchByPublicId(
        request.params.creatorPublicId,
        userId,
      )
      if (!creator) {
        throw new AppError(404, 'Creator not found', 'NOT_FOUND')
      }
      await prisma.broadcastReminder.upsert({
        where: {
          userId_creatorId: { userId, creatorId: creator.userId },
        },
        create: {
          userId,
          creatorId: creator.userId,
          notifyOnLive: parsed.data.enabled,
        },
        update: { notifyOnLive: parsed.data.enabled },
      })
      return reply.send({ success: true, enabled: parsed.data.enabled })
    },
  )

  app.get<{ Params: { creatorPublicId: string } }>(
    '/live-notify/:creatorPublicId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Reminders'],
        description: 'Read "notify me whenever they go live" state for a creator',
        params: {
          type: 'object',
          required: ['creatorPublicId'],
          properties: { creatorPublicId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { creatorPublicId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const creator = await userSearchService.searchByPublicId(
        request.params.creatorPublicId,
        userId,
      )
      if (!creator) {
        throw new AppError(404, 'Creator not found', 'NOT_FOUND')
      }
      const row = await prisma.broadcastReminder.findUnique({
        where: { userId_creatorId: { userId, creatorId: creator.userId } },
        select: { notifyOnLive: true },
      })
      return reply.send({ enabled: row?.notifyOnLive ?? false })
    },
  )
}
