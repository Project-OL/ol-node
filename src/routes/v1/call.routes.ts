import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { UpdateCallSettingsSchema, InitiateCallSchema } from '../../models/call.schemas'
import { videoCallSettingsService, videoCallSessionService } from '../../services/video-call.service'

export default async function callRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  // ── Settings ────────────────────────────────────────────────────────────────

  app.get(
    '/settings',
    {
      preHandler: preAuth,
      schema: { tags: ['Video Call'], description: 'Get my video call settings and price cap for my current livestream level' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const settings = await videoCallSettingsService.get(request.userId!)
      return reply.send(settings)
    },
  )

  app.put<{ Body: unknown }>(
    '/settings',
    {
      preHandler: preAuth,
      schema: { tags: ['Video Call'], description: 'Update video call price and caller restrictions' },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parsed = UpdateCallSettingsSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid request', 'INVALID_REQUEST')
      }
      const updated = await videoCallSettingsService.update(request.userId!, parsed.data)
      return reply.send(updated)
    },
  )

  app.get(
    '/price-table',
    {
      preHandler: preAuth,
      schema: { tags: ['Video Call'], description: 'Get the call price cap table (livestream level → max coins/min)' },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ priceTable: videoCallSettingsService.priceTable() })
    },
  )

  // ── Sessions ─────────────────────────────────────────────────────────────────

  app.post<{ Body: unknown }>(
    '/initiate',
    {
      preHandler: preAuth,
      schema: { tags: ['Video Call'], description: 'Initiate a video call to a creator by publicId' },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parsed = InitiateCallSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid request', 'INVALID_REQUEST')
      }
      const result = await videoCallSessionService.initiate(request.userId!, parsed.data.creatorPublicId)
      return reply.code(201).send(result)
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/tick',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Video Call'],
        description: 'Minute tick: deduct coins from caller, credit points to creator. Returns canContinue flag.',
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: { sessionId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const result = await videoCallSessionService.tick(request.params.sessionId, request.userId!)
      return reply.send(result)
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/end',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Video Call'],
        description: 'End an active call session (caller or creator can call this)',
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: { sessionId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const result = await videoCallSessionService.end(request.params.sessionId, request.userId!)
      return reply.send(result)
    },
  )

  app.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/token',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Video Call'],
        description: 'Get a LiveKit join token for an active session (for creator to join after notification)',
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: { sessionId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const result = await videoCallSessionService.joinToken(request.params.sessionId, request.userId!)
      return reply.send(result)
    },
  )
}
