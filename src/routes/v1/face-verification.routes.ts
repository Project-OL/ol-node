import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { rateLimitFaceRegister, rateLimitFaceVerify } from '../../middlewares/rateLimitAuth'
import { faceActionBodySchema } from '../../models/face-verification.schemas'
import { faceVerificationService } from '../../services/face-verification.service'

const preAuth = [authenticate]

export default async function faceVerificationRoutes(app: FastifyInstance) {
  app.post('/register/upload-url', { preHandler: preAuth }, async (request) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    return faceVerificationService.createRegistrationUploadUrl(userId)
  })

  app.post('/register', { preHandler: [...preAuth, rateLimitFaceRegister] }, async (request) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const parsed = faceActionBodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid body', 'INVALID_REQUEST')
    }
    return faceVerificationService.registerFromUploadedKey(userId, parsed.data, request)
  })

  app.get('/me', { preHandler: preAuth }, async (request) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    return faceVerificationService.getMyFaceProfile(userId)
  })

  app.delete('/me', { preHandler: preAuth }, async (request) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    return faceVerificationService.revokeMyFaceProfile(userId)
  })

  app.post('/verify/upload-url', { preHandler: preAuth }, async (request) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    return faceVerificationService.createVerificationUploadUrl(userId)
  })

  app.post(
    '/verify',
    { preHandler: [...preAuth, rateLimitFaceVerify] },
    async (request: FastifyRequest) => {
      const userId = (request as { userId?: string }).userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = faceActionBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return faceVerificationService.verifyFromUploadedKey(userId, parsed.data, request)
    },
  )

  app.post('/liveness/session', { preHandler: preAuth }, async (request) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    return faceVerificationService.createLivenessSession(userId)
  })
}
