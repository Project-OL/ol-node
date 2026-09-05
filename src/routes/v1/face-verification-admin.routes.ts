import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminAcceptDuplicateBodySchema,
  adminListCollectionFacesQuerySchema,
  adminListFaceProfilesQuerySchema,
  adminListPendingDuplicatesQuerySchema,
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

const clearStuckSessionsBodySchema = z.object({
  reason: z.string().max(500).optional(),
})

const listStuckSessionsQuerySchema = z.object({
  minAgeSec: z.coerce.number().int().min(0).max(86_400).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  userId: z.string().uuid().optional(),
})

const clearAllStuckSessionsBodySchema = z.object({
  minAgeSec: z.coerce.number().int().min(0).max(86_400).optional(),
  userId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
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
    '/face-verification/:userId/registration-sessions/clear',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          'Force-expire every non-terminal face_registration_sessions row for a user (stuck PENDING/UPLOADED/PROCESSING/LIVENESS_PASSED/INDEX_PENDING) and reset the liveness session/verify rate limits + processing lock, so the user can start a fresh registration attempt from the app.',
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
      const parsed = clearStuckSessionsBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminId = request.adminUser?.id
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.clearStuckRegistrationSessions(
        request.params.userId,
        adminId,
        parsed.data.reason,
      )
      return reply.send(result)
    },
  )

  app.get(
    '/face-verification/registration-sessions/stuck',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          "Paginated worklist of users whose LATEST face_registration_sessions row still needs attention -- hung (PENDING/UPLOADED/PROCESSING/LIVENESS_PASSED/INDEX_PENDING) or a terminal failure they haven't retried past (LIVENESS_FAILED/VALIDATION_FAILED/REJECTED) -- older than minAgeSec, across all users (or one, via userId), with the user's name/publicId and failureReason. Pair with the recheck, clear, and clear-all endpoints.",
        querystring: {
          type: 'object',
          properties: {
            minAgeSec: { type: 'integer', minimum: 0, maximum: 86400 },
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            userId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listStuckSessionsQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await faceVerificationAdminService.listStuckRegistrationSessions(parsed.data)
      return reply.send(result)
    },
  )

  app.post(
    '/face-verification/registration-sessions/clear-all',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          'Bulk version of the per-user clear endpoint: clears every user currently matching the "needs attention" worklist (same minAgeSec/userId filters as the GET above) in one server-side pass instead of the caller looping individual clear calls. Force-expires each matching user\'s stuck/failed session and resets their liveness rate-limit/lock Redis keys.',
        body: {
          type: 'object',
          properties: {
            minAgeSec: { type: 'integer', minimum: 0, maximum: 86400 },
            userId: { type: 'string', format: 'uuid' },
            reason: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = clearAllStuckSessionsBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminId = request.adminUser?.id
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.clearAllStuckRegistrationSessions(
        adminId,
        parsed.data,
      )
      return reply.send(result)
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/face-verification/:userId/registration-sessions',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description: 'Every open (non-terminal) registration session for one user, with age.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const sessions = await faceVerificationAdminService.getOpenRegistrationSessionsForUser(
        request.params.userId,
      )
      return reply.send({ sessions })
    },
  )

  app.post<{ Params: { userId: string; sessionId: string } }>(
    '/face-verification/:userId/registration-sessions/:sessionId/recheck',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          "Non-destructive: re-queues the BullMQ verify job for a PENDING/UPLOADED/PROCESSING session right now instead of waiting for the client or the job's own backoff. Rejects LIVENESS_PASSED/INDEX_PENDING (worker-face-index's domain, not this queue) -- use the clear endpoint for those if genuinely stuck.",
        params: {
          type: 'object',
          required: ['userId', 'sessionId'],
          properties: {
            userId: { type: 'string', format: 'uuid' },
            sessionId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { userId: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const adminId = request.adminUser?.id
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.recheckRegistrationSession(
        request.params.userId,
        request.params.sessionId,
        adminId,
      )
      return reply.send(result)
    },
  )

  app.get(
    '/face-verification/duplicates/pending',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          "Paginated worklist of pending duplicate-face cases (status DUPLICATE_FACE), each row pairing the blocked user with the matched/owner account — both users' names, public ids, and reference images — for a single review-and-decide view.",
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminListPendingDuplicatesQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await faceVerificationAdminService.listPendingDuplicates(parsed.data)
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/face-verification/:userId/accept-duplicate',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Face verification'],
        description:
          "Accept both accounts despite the duplicate match: indexes the blocked user's stored image in Rekognition anyway and marks their profile INDEXED. The matched/owner account is left untouched. Use resolve-duplicate instead if the match was real and one side should re-register.",
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
      const parsed = adminAcceptDuplicateBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminId = request.adminUser?.id
      if (!adminId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await faceVerificationAdminService.acceptDuplicateBothAccounts(
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
