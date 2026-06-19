import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../middlewares/errorHandler'
import { requireAdmin } from '../../middlewares/requireAdmin'
import { faceVerificationAdminService } from '../../services/face-verification-admin.service'

const preAuth = [requireAdmin]

const revokeBodySchema = z.object({
  reason: z.string().max(500).optional(),
})

const resolveDuplicateBodySchema = z.object({
  reason: z.string().max(500).optional(),
  /** When false, only clears the blocked user; does not revoke the indexed owner. Default true. */
  revokeIndexedOwner: z.boolean().optional(),
})

export default async function faceVerificationAdminRoutes(app: FastifyInstance) {
  app.delete<{ Params: { userId: string } }>(
    '/face-verification/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          'Revoke face profile (INDEXED, DUPLICATE_FACE, FAILED, PENDING_INDEX): DeleteFaces when indexed, mark REVOKED, audit. User may register again.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: { reason: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = revokeBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminId = request.userId
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.revokeUserFaceProfile(
        request.params.userId,
        adminId,
        parsed.data.reason,
      )
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/face-verification/:userId/resolve-duplicate',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          'Clear DUPLICATE_FACE for blocked user and optionally revoke indexed owner in AWS + DB so both can register again.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            reason: { type: 'string', maxLength: 500 },
            revokeIndexedOwner: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = resolveDuplicateBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminId = request.userId
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.resolveDuplicateIdentity(
        request.params.userId,
        adminId,
        parsed.data.reason,
        parsed.data.revokeIndexedOwner !== false,
      )
      return reply.send(result)
    },
  )

  app.delete<{ Params: { userId: string } }>(
    '/face-verification/:userId/from-collection',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          'Delete face from Rekognition collection only (no DB change). For migration/cleanup.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const adminId = request.userId
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.deleteFromCollectionOnly(
        request.params.userId,
        adminId,
      )
      return reply.send(result)
    },
  )
}
