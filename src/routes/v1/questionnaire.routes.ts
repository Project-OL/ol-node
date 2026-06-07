import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { questionnaireSubmitRateLimit } from '../../middlewares/rateLimitAuth'
import {
  keyParamSchema,
  myAttemptsQuerySchema,
  submitQuestionnaireBodySchema,
} from '../../models/questionnaire.schemas'
import { questionnaireService } from '../../services/questionnaire.service'

export default async function questionnaireRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.get<{ Params: unknown }>('/:key', { preHandler: preAuth }, async (request, reply) => {
    const parsed = keyParamSchema.safeParse(request.params)
    if (!parsed.success) throw new AppError(400, 'Invalid questionnaire key', 'invalid_payload')
    return reply.send(await questionnaireService.getPublicActiveByKey(parsed.data.key))
  })

  app.get<{ Params: unknown }>(
    '/:key/my-status',
    { preHandler: preAuth },
    async (request, reply) => {
      const parsed = keyParamSchema.safeParse(request.params)
      if (!parsed.success) throw new AppError(400, 'Invalid questionnaire key', 'invalid_payload')
      return reply.send(await questionnaireService.getMyStatus(request.userId!, parsed.data.key))
    },
  )

  app.post<{ Params: unknown; Body: unknown }>(
    '/:key/submit',
    { preHandler: [...preAuth, questionnaireSubmitRateLimit] },
    async (request: FastifyRequest<{ Params: unknown; Body: unknown }>, reply: FastifyReply) => {
      const params = keyParamSchema.safeParse(request.params)
      if (!params.success) throw new AppError(400, 'Invalid questionnaire key', 'invalid_payload')
      const body = submitQuestionnaireBodySchema.safeParse(request.body)
      if (!body.success)
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Invalid payload',
          'invalid_payload',
        )
      const result = await questionnaireService.submit(
        request.userId!,
        params.data.key,
        body.data.answers,
      )
      return reply.status(201).send(result)
    },
  )

  app.get<{ Params: unknown; Querystring: unknown }>(
    '/:key/my-attempts',
    { preHandler: preAuth },
    async (
      request: FastifyRequest<{ Params: unknown; Querystring: unknown }>,
      reply: FastifyReply,
    ) => {
      const params = keyParamSchema.safeParse(request.params)
      if (!params.success) throw new AppError(400, 'Invalid questionnaire key', 'invalid_payload')
      const query = myAttemptsQuerySchema.safeParse(request.query)
      if (!query.success)
        throw new AppError(
          400,
          query.error.errors[0]?.message ?? 'Invalid query',
          'invalid_payload',
        )
      return reply.send(
        await questionnaireService.listMyAttempts(request.userId!, params.data.key, query.data),
      )
    },
  )
}
