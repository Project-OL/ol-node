import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  rateLimitLivePhotoUploadUrl,
  rateLimitLivePhotoVerify,
} from '../../middlewares/rateLimitAuth'
import {
  livePhotoUploadUrlBodySchema,
  livePhotoVerifyBodySchema,
} from '../../models/live-photo.schemas'
import { livePhotoService } from '../../services/livePhoto.service'

const preAuth = [authenticate]

export default async function livePhotoRoutes(app: FastifyInstance) {
  app.get('/me', { preHandler: preAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId
    if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const data = await livePhotoService.getMeStatus(userId)
    return reply.send(data)
  })

  app.post(
    '/upload-url',
    { preHandler: [...preAuth, rateLimitLivePhotoUploadUrl] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = livePhotoUploadUrlBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const data = await livePhotoService.createUploadUrl(userId, parsed.data.mimeType)
      return reply.send(data)
    },
  )

  app.post(
    '/verify',
    { preHandler: [...preAuth, rateLimitLivePhotoVerify] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = livePhotoVerifyBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const rid = typeof request.id === 'string' ? request.id : undefined
      const result = await livePhotoService.requestVerify(userId, parsed.data.s3Key, rid)
      return reply.send(result)
    },
  )

  app.delete('/', { preHandler: preAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId
    if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const data = await livePhotoService.remove(userId)
    return reply.send(data)
  })
}
