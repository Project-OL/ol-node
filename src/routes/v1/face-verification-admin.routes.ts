import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminListCollectionFacesQuerySchema,
  adminListFaceProfilesQuerySchema,
  adminRevokeFaceBodySchema,
} from '../../models/face-verification.schemas'
import { faceVerificationAdminService } from '../../services/face-verification-admin.service'
import { z } from 'zod'

const preAuth = [authenticateAdmin]

const resolveDuplicateBodySchema = z.object({
  reason: z.string().max(500).optional(),
  /** When false, only clears the blocked user; does not revoke the indexed owner. Default true. */
  revokeIndexedOwner: z.boolean().optional(),
})

export default async function faceVerificationAdminRoutes(app: FastifyInstance) {
  app.get(
    '/face-verification/profiles',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          'Paginated list of `user_face_profiles` with user summary and duplicate linkage.',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            status: {
              type: 'string',
              enum: ['PENDING_INDEX', 'INDEXED', 'FAILED', 'REVOKED', 'DUPLICATE_FACE'],
            },
            includeRevoked: { type: 'boolean' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminListFaceProfilesQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await faceVerificationAdminService.listDbProfiles(parsed.data)
      return reply.send(result)
    },
  )

  app.get(
    '/face-verification/collection',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          'Paginated Rekognition collection faces with DB linkage (`linked`, `db_mismatch`, `orphaned_in_collection`).',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 4096 },
            nextToken: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminListCollectionFacesQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await faceVerificationAdminService.listCollectionFaces(parsed.data)
      return reply.send(result)
    },
  )

  app.get(
    '/face-verification/inventory/summary',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description: 'DB profile counts by status + Rekognition collection face count.',
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await faceVerificationAdminService.getInventorySummary()
      return reply.send(result)
    },
  )

  app.delete<{ Params: { userId: string } }>(
    '/face-verification/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          'Revoke face profile (INDEXED, DUPLICATE_FACE, FAILED, PENDING_INDEX): DeleteFaces when indexed, mark REVOKED, audit. By default also revokes related DUPLICATE_FACE profiles.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            reason: { type: 'string', maxLength: 500 },
            revokeRelated: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminRevokeFaceBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminId = request.adminUser?.id
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.revokeUserFaceProfile(
        request.params.userId,
        adminId,
        parsed.data.reason,
        { revokeRelated: parsed.data.revokeRelated },
      )
      return reply.send(result)
    },
  )

  app.delete<{ Params: { faceId: string } }>(
    '/face-verification/collection/:faceId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          'Revoke by Rekognition FaceId: delete from collection and revoke linked DB profile(s) + related duplicates.',
        params: {
          type: 'object',
          required: ['faceId'],
          properties: { faceId: { type: 'string', minLength: 1 } },
        },
        body: {
          type: 'object',
          properties: {
            reason: { type: 'string', maxLength: 500 },
            revokeRelated: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { faceId: string } }>, reply: FastifyReply) => {
      const parsed = adminRevokeFaceBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminId = request.adminUser?.id
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.revokeByRekognitionFaceId(
        request.params.faceId,
        adminId,
        parsed.data.reason,
        { revokeRelated: parsed.data.revokeRelated },
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
      const adminId = request.adminUser?.id
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
      const adminId = request.adminUser?.id
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.deleteFromCollectionOnly(
        request.params.userId,
        adminId,
      )
      return reply.send(result)
    },
  )
}
