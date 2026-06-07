import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin } from '../../middlewares/requireAdmin'
import { AppError } from '../../middlewares/errorHandler'
import { questionnaireAdminRateLimit } from '../../middlewares/rateLimitAuth'
import {
  createQuestionnaireBodySchema,
  patchQuestionnaireMetaBodySchema,
} from '../../models/questionnaire.schemas'
import { questionnaireService } from '../../services/questionnaire.service'

export default async function questionnaireAdminRoutes(app: FastifyInstance) {
  const preAdmin = [requireAdmin, questionnaireAdminRateLimit]

  app.get('/', { preHandler: preAdmin }, async (_request, reply) => {
    return reply.send(await questionnaireService.adminList())
  })

  app.get<{ Params: { id: string } }>('/:id', { preHandler: preAdmin }, async (request, reply) => {
    return reply.send(await questionnaireService.adminGet(request.params.id))
  })

  app.post<{ Body: unknown }>(
    '/',
    { preHandler: preAdmin },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parsed = createQuestionnaireBodySchema.safeParse(request.body)
      if (!parsed.success)
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid payload',
          'invalid_payload',
        )
      const created = await questionnaireService.adminCreate(request.userId!, parsed.data)
      return reply.status(201).send(created)
    },
  )

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/:id',
    { preHandler: preAdmin },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const parsed = patchQuestionnaireMetaBodySchema.safeParse(request.body)
      if (!parsed.success)
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid payload',
          'invalid_payload',
        )
      return reply.send(
        await questionnaireService.adminPatchMeta(request.userId!, request.params.id, parsed.data),
      )
    },
  )

  app.post<{ Params: { id: string } }>(
    '/:id/deactivate',
    { preHandler: preAdmin },
    async (request, reply) => {
      return reply.send(
        await questionnaireService.adminDeactivate(request.userId!, request.params.id),
      )
    },
  )

  app.post<{ Params: { id: string } }>(
    '/:id/activate',
    { preHandler: preAdmin },
    async (request, reply) => {
      return reply.send(
        await questionnaireService.adminActivate(request.userId!, request.params.id),
      )
    },
  )
}
