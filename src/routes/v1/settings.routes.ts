import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { createPrivacyRateLimit } from '../../middlewares/rateLimitAuth'
import {
  updateLanguageSchema,
  updateMessagePrivacySchema,
  updateLiveMicStatusSchema,
} from '../../models/schemas'
import { userSettingsService } from '../../services/userSettings.service'
import { privacyService } from '../../services/privacy.service'
import { AppError } from '../../middlewares/errorHandler'

const settingsRateLimit = createPrivacyRateLimit({
  endpoint: 'settings.update',
  max: 10,
  windowMs: 10 * 60 * 1000,
})

export default async function settingsRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.get(
    '/preferences',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Settings'],
        description: 'Get user language, messaging privacy, and live mic privacy settings',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const [settings, privacy] = await Promise.all([
        userSettingsService.getOrCreateSettings(userId),
        privacyService.getUserPrivacySettings(userId),
      ])

      return reply.status(200).send({
        language: settings.language,
        messagePrivacy: {
          allowMsgFromMutual: settings.allowMsgFromMutual,
          allowMsgFromFollowing: settings.allowMsgFromFollowing,
          allowMsgFromStranger: settings.allowMsgFromStranger,
        },
        liveMicHidden: privacy.hideMicStatus ?? false,
      })
    },
  )

  app.put(
    '/language',
    {
      preHandler: [...preAuth, settingsRateLimit],
      schema: {
        tags: ['Settings'],
        description: 'Update language preference',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = updateLanguageSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
        )
      }

      const result = await userSettingsService.updateLanguage(userId, parsed.data.language, {
        request: {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        },
        deviceId: request.deviceId ?? null,
      })

      return reply.status(200).send({ language: result.language })
    },
  )

  app.put(
    '/message-privacy',
    {
      preHandler: [...preAuth, settingsRateLimit],
      schema: {
        tags: ['Settings'],
        description: 'Update messaging privacy preferences',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = updateMessagePrivacySchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
        )
      }

      const result = await userSettingsService.updateMessagePrivacy(
        userId,
        parsed.data,
        {
          request: {
            ip: request.ip,
            headers: request.headers as Record<string, string | undefined>,
          },
          deviceId: request.deviceId ?? null,
        },
      )

      return reply.status(200).send({
        allowMsgFromMutual: result.allowMsgFromMutual,
        allowMsgFromFollowing: result.allowMsgFromFollowing,
        allowMsgFromStranger: result.allowMsgFromStranger,
      })
    },
  )

  app.put(
    '/live-privacy',
    {
      preHandler: [...preAuth, settingsRateLimit],
      schema: {
        tags: ['Settings'],
        description: 'Update live mic visibility status',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = updateLiveMicStatusSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
        )
      }

      const result = await privacyService.updateLiveMicStatus(
        userId,
        parsed.data.hideMicStatus,
        {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        },
      )

      return reply.status(200).send({ hideMicStatus: result.hideMicStatus ?? false })
    },
  )
}

