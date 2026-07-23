import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { rateLimitReport } from '../../middlewares/rateLimitAuth'
import { CreateReportSchema, GetReportEvidenceUploadUrlsSchema } from '../../models/messaging.schemas'
import { z } from 'zod'
import { reportService } from '../../services/report.service'
import { uploadService } from '../../services/upload.service'
import { AppError } from '../../middlewares/errorHandler'

export default async function reportRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.post<{ Body: unknown }>(
    '/',
    {
      preHandler: [...preAuth, rateLimitReport],
      schema: {
        tags: ['Reports'],
        description: 'Create a report',
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = CreateReportSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const report = await reportService.createReport(userId, parsed.data)
      return reply.code(201).send({ report })
    },
  )

  app.get<{ Querystring: { count?: string } }>(
    '/upload-urls',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Reports'],
        description: 'Get evidence image upload URLs',
      },
    },
    async (request: FastifyRequest<{ Querystring: { count?: string } }>, reply: FastifyReply) => {
      const userId = request.userId!
      const countParsed = z.coerce.number().int().min(1).max(5).safeParse(request.query.count)
      if (!countParsed.success) {
        throw new AppError(400, 'count must be between 1 and 5', 'INVALID_REQUEST')
      }
      const urls = await uploadService.getReportEvidenceUploadUrls(userId, countParsed.data)
      return reply.send({ urls })
    },
  )

  app.post<{ Body: unknown }>(
    '/upload-urls',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Reports'],
        description: 'Get evidence upload URLs, image or video (up to 5 files)',
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = GetReportEvidenceUploadUrlsSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      const urls = await uploadService.getReportEvidenceUploadUrlsV2(userId, parsed.data.files)
      return reply.send({ urls })
    },
  )
}
