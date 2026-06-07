import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { privacyRateLimits } from '../../middlewares/rateLimitAuth'
import { togglePrivacySchema } from '../../models/privacy.schemas'
import { privacyService } from '../../services/privacy.service'
import { AppError } from '../../middlewares/errorHandler'

function handleRouteError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  throw error
}

export default async function privacyRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  // GET /api/v1/privacy/settings — 60/min
  app.get<{ Querystring: Record<string, unknown> }>(
    '/settings',
    {
      preHandler: [...preAuth, privacyRateLimits.getSettings],
      schema: {
        tags: ['Privacy'],
        description: 'Get all VIP privacy settings (batch). Requires VIP subscription.',
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  vipActive: { type: 'boolean' },
                  settings: { type: 'object' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const startTime = Date.now()
      try {
        const userId = request.userId!
        const result = await privacyService.getSettings(userId)

        app.log.info({
          action: 'privacy.get_settings',
          userId,
          statusCode: 200,
          responseTime: Date.now() - startTime,
        })

        return reply.status(200).send({
          data: {
            ...result,
            updatedAt: result.updatedAt.toISOString(),
          },
        })
      } catch (error) {
        return handleRouteError(error, reply)
      }
    },
  )

  const togglePreHandler = [...preAuth, privacyRateLimits.toggle]

  // PUT /api/v1/privacy/invisible-visitor — 10/min
  app.put<{ Body: { enabled?: unknown } }>(
    '/invisible-visitor',
    {
      preHandler: togglePreHandler,
      schema: {
        tags: ['Privacy'],
        description: 'Toggle invisible visitor. Requires VIP.',
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  feature: { type: 'string' },
                  enabled: { type: 'boolean' },
                  message: { type: 'string' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const userId = request.userId!
        const parsed = togglePrivacySchema.safeParse(request.body ?? {})
        if (!parsed.success) {
          throw new AppError(
            400,
            parsed.error.errors[0]?.message ?? 'Validation failed',
            'INVALID_REQUEST',
          )
        }
        const result = await privacyService.toggleInvisibleVisitor(userId, parsed.data.enabled, {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        })
        return reply.status(200).send({
          data: {
            ...result,
            updatedAt: result.updatedAt.toISOString(),
          },
        })
      } catch (error) {
        return handleRouteError(error, reply)
      }
    },
  )

  // PUT /api/v1/privacy/mystery-live — 10/min
  app.put<{ Body: { enabled?: unknown } }>(
    '/mystery-live',
    {
      preHandler: togglePreHandler,
      schema: {
        tags: ['Privacy'],
        description: 'Toggle mystery man in live room. Requires VIP.',
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  feature: { type: 'string' },
                  enabled: { type: 'boolean' },
                  message: { type: 'string' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const userId = request.userId!
        const parsed = togglePrivacySchema.safeParse(request.body ?? {})
        if (!parsed.success) {
          throw new AppError(
            400,
            parsed.error.errors[0]?.message ?? 'Validation failed',
            'INVALID_REQUEST',
          )
        }
        const result = await privacyService.toggleMysteryLive(userId, parsed.data.enabled, {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        })
        return reply.status(200).send({
          data: {
            ...result,
            updatedAt: result.updatedAt.toISOString(),
          },
        })
      } catch (error) {
        return handleRouteError(error, reply)
      }
    },
  )

  // PUT /api/v1/privacy/mystery-rank — 10/min
  app.put<{ Body: { enabled?: unknown } }>(
    '/mystery-rank',
    {
      preHandler: togglePreHandler,
      schema: {
        tags: ['Privacy'],
        description: 'Toggle mystery man on rank. Requires VIP.',
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  feature: { type: 'string' },
                  enabled: { type: 'boolean' },
                  message: { type: 'string' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const userId = request.userId!
        const parsed = togglePrivacySchema.safeParse(request.body ?? {})
        if (!parsed.success) {
          throw new AppError(
            400,
            parsed.error.errors[0]?.message ?? 'Validation failed',
            'INVALID_REQUEST',
          )
        }
        const result = await privacyService.toggleMysteryRank(userId, parsed.data.enabled, {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        })
        return reply.status(200).send({
          data: {
            ...result,
            updatedAt: result.updatedAt.toISOString(),
          },
        })
      } catch (error) {
        return handleRouteError(error, reply)
      }
    },
  )

  // PUT /api/v1/privacy/invisible-online — 10/min
  app.put<{ Body: { enabled?: unknown } }>(
    '/invisible-online',
    {
      preHandler: togglePreHandler,
      schema: {
        tags: ['Privacy'],
        description: 'Toggle invisible online. Requires VIP. Auto-disables when live streaming.',
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  feature: { type: 'string' },
                  enabled: { type: 'boolean' },
                  message: { type: 'string' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const userId = request.userId!
        const parsed = togglePrivacySchema.safeParse(request.body ?? {})
        if (!parsed.success) {
          throw new AppError(
            400,
            parsed.error.errors[0]?.message ?? 'Validation failed',
            'INVALID_REQUEST',
          )
        }
        const result = await privacyService.toggleInvisibleOnline(userId, parsed.data.enabled, {
          ip: request.ip,
          headers: request.headers as Record<string, string | undefined>,
        })
        return reply.status(200).send({
          data: {
            ...result,
            updatedAt: result.updatedAt.toISOString(),
          },
        })
      } catch (error) {
        return handleRouteError(error, reply)
      }
    },
  )
}
