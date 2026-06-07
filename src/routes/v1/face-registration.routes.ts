import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  rateLimitFaceRegistrationSession,
  rateLimitFaceRegistrationVerify,
} from '../../middlewares/rateLimitAuth'
import {
  faceRegistrationSessionCreateBodySchema,
  faceRegistrationUploadUrlBodySchema,
  faceRegistrationVerifyBodySchema,
} from '../../models/face-registration.schemas'
import { faceRegistrationService } from '../../services/faceRegistration.service'

const preAuth = [authenticate]

export default async function faceRegistrationRoutes(app: FastifyInstance) {
  app.post(
    '/session',
    { preHandler: [...preAuth, rateLimitFaceRegistrationSession] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = faceRegistrationSessionCreateBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const data = await faceRegistrationService.createSession(userId, request, parsed.data)
      return reply.send(data)
    },
  )

  app.post(
    '/upload-url',
    { preHandler: [...preAuth, rateLimitFaceRegistrationSession] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = faceRegistrationUploadUrlBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const data = await faceRegistrationService.createUploadUrl(
        userId,
        parsed.data.sessionId,
        parsed.data.mimeType,
        request,
      )
      return reply.send(data)
    },
  )

  app.post(
    '/verify',
    { preHandler: [...preAuth, rateLimitFaceRegistrationVerify] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = faceRegistrationVerifyBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const rid = typeof request.id === 'string' ? request.id : undefined
      const data = await faceRegistrationService.requestVerify(
        userId,
        parsed.data.sessionId,
        parsed.data.idempotencyKey,
        request,
        rid,
      )
      return reply.send(data)
    },
  )
}
