import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { adminUserTagsBodySchema } from '../../models/admin-user-tags.schemas'
import { adminUserSearchQuerySchema } from '../../models/admin-user-search.schemas'
import { adminUserPatchBodySchema } from '../../models/admin-user-detail.schemas'
import {
  adminGovtIdConfirmSchema,
  adminGovtIdUploadUrlSchema,
  adminKycContactPatchSchema,
} from '../../models/agency-admin.schemas'
import { agencyKycService } from '../../services/agencyKyc.service'
import { adminUserTagsService } from '../../services/admin-user-tags.service'
import { adminUserSearchService } from '../../services/adminUserSearch.service'
import { adminUserDetailService } from '../../services/adminUserDetail.service'
import { adminUserVipGuardianService } from '../../services/adminUserVipGuardian.service'
import { storeAdminService } from '../../services/store-admin.service'
import { userLocationService } from '../../services/userLocation.service'
import {
  adminLocationsQuerySchema,
  locationHistoryQuerySchema,
} from '../../models/user-location.schemas'
import { auditService } from '../../services/audit.service'

const preAuth = [authenticateAdmin]

const adminUserVipQuerySchema = z.object({
  purchasesLimit: z.coerce.number().int().min(1).max(100).optional(),
  purchasesCursor: z.string().min(1).optional(),
  claimsLimit: z.coerce.number().int().min(1).max(100).optional(),
  claimsCursor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'claimsCursor must be YYYY-MM-DD')
    .optional(),
})

const adminUserGuardiansQuerySchema = z.object({
  purchaseHistoryLimit: z.coerce.number().int().min(1).max(100).optional(),
})

export default async function userAdminRoutes(app: FastifyInstance) {
  app.get(
    '/users/search',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Search users by name (first name alone, last name, full name, or username; multi-match list), user id (UUID), public id, email, phone (E.164), or device id. Use `type=auto` (default) or force a field. Exact single matches are recorded in per-admin search history.',
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 255 },
            type: {
              type: 'string',
              enum: ['auto', 'name', 'userId', 'publicId', 'email', 'phone', 'deviceId'],
            },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            includeStore: { type: 'boolean' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminUserSearchQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const result = await adminUserSearchService.search(parsed.data, {
        adminUserId: request.adminUser!.id,
      })
      return reply.send(result)
    },
  )

  app.get(
    '/users/search/history',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Last 10 users this admin searched (exact match) or opened via GET /users/:userId. Per-admin Redis history.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await adminUserSearchService.getHistory(request.adminUser!.id))
    },
  )

  app.get(
    '/users/stats',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'User search page stats: total non-deleted users, count registered since UTC midnight, and up to 50 of those accounts (newest first).',
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await adminUserSearchService.getRegistrationStats())
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Full user profile for admin (identity incl. firstName/lastName/name, VIP, agency, device, status). Also records search history.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminUserDetailService.getUserDetail(request.params.userId, {
          adminUserId: request.adminUser!.id,
        }),
      )
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/store-items',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Store'],
        description: 'User-owned store items and currently equipped cosmetics.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      return reply.send(await storeAdminService.getUserStoreSummary(request.params.userId))
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/wallet',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Wallet'],
        description: 'User wallet balances and lifetime recharge / withdrawal totals.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      return reply.send(await adminUserDetailService.getUserWallet(request.params.userId))
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/live-summary',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Live'],
        description:
          'This-week live summary for User Detail: sum of effective_duration_seconds for streams ending in the IST Sunday 23:30 week (parity with Live-server host-stats), plus won points and new followers.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      return reply.send(await adminUserDetailService.getLiveSummary(request.params.userId))
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/vip',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'VIP'],
        description:
          'Full VIP dossier for a user: current membership + expiry, rare VIP public id, rich tier, purchase history, daily claim history, and privilege flags.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
        querystring: {
          type: 'object',
          properties: {
            purchasesLimit: { type: 'integer', minimum: 1, maximum: 100 },
            purchasesCursor: { type: 'string' },
            claimsLimit: { type: 'integer', minimum: 1, maximum: 100 },
            claimsCursor: { type: 'string', description: 'YYYY-MM-DD' },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = adminUserVipQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminUserVipGuardianService.getUserVipDetail(request.params.userId, {
          purchasesLimit: parsed.data.purchasesLimit,
          purchasesCursor: parsed.data.purchasesCursor,
          claimsLimit: parsed.data.claimsLimit,
          claimsCursor: parsed.data.claimsCursor,
        }),
      )
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/guardians',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Guardian'],
        description:
          'Guardian relationships for a user (as buyer and as target), including expired rows, counterparty cards, plus coin-ledger guardian purchase history.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
        querystring: {
          type: 'object',
          properties: {
            purchaseHistoryLimit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = adminUserGuardiansQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminUserVipGuardianService.getUserGuardians(request.params.userId, {
          purchaseHistoryLimit: parsed.data.purchaseHistoryLimit,
        }),
      )
    },
  )

  app.get(
    '/locations',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Location'],
        description:
          'Global GPS location sample feed (newest first). Filter by userId (UUID), publicId (public or display ID), from / to.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminLocationsQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(await userLocationService.listForAdmin(parsed.data))
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/locations',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Location'],
        description: 'Current GPS location + history samples for one user.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const parsed = locationHistoryQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await userLocationService.getUserLocationsForAdmin(request.params.userId, {
          limit: parsed.data.limit,
          cursor: parsed.data.cursor,
        }),
      )
    },
  )

  app.patch<{ Params: { userId: string } }>(
    '/users/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Partial update — send only fields to change (e.g. `{ "firstName": "Jane" }`, `{ "gender": "female" }`). Optional `firstName` (non-empty) / `lastName` (empty string clears). Omitting username/name fields never clears them. Gender is locked while face verification is active (`FACE_VERIFIED_GENDER_LOCKED`). Ban and suspend revoke sessions. Activate does not (sessions were already revoked at ban/suspend).',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminUserPatchBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const result = await adminUserDetailService.updateUser(request.params.userId, parsed.data, {
        allowRestricted: request.adminUser?.role === 'SUPER_ADMIN',
      })
      const changedFields = Object.keys(parsed.data).filter((k) => k !== 'status')
      if (changedFields.length > 0) {
        auditService.logAdminFromRequest(request, {
          actionType: 'ADMIN_USER_UPDATED',
          targetUserId: request.params.userId,
          actionDetails: { fields: changedFields },
        })
      }
      if (parsed.data.status) {
        auditService.logAdminFromRequest(request, {
          actionType: 'ADMIN_USER_STATUS_CHANGED',
          targetUserId: request.params.userId,
          actionDetails: { status: parsed.data.status },
        })
      }
      return reply.send(result)
    },
  )

  app.patch<{ Params: { userId: string } }>(
    '/users/:userId/kyc-contact',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Update agency KYC-linked phone and/or email. Shown when the user has applied for KYC. Does not change login email/phone.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminKycContactPatchSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const result = await agencyKycService.updateAdminKycContact(request.params.userId, parsed.data)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_KYC_CONTACT_UPDATED',
        targetUserId: request.params.userId,
        actionDetails: { userId: request.params.userId, fields: Object.keys(parsed.data) },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/kyc/govt-id/upload-url',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Presign S3 PUT for replacing agency KYC government ID. Allowed even if the application is approved or rejected.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminGovtIdUploadUrlSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const data = await agencyKycService.getPresignedGovtIdUrl(
        request.params.userId,
        parsed.data.mimeType,
        { admin: true },
      )
      return reply.send(data)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/kyc/govt-id/confirm',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description: 'Confirm government ID upload after PUT to the presigned URL.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminGovtIdConfirmSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const result = await agencyKycService.confirmAdminGovtIdUpload(
        request.params.userId,
        parsed.data.s3Key,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_KYC_GOVT_ID_UPDATED',
        targetUserId: request.params.userId,
        actionDetails: { userId: request.params.userId, s3Key: parsed.data.s3Key },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/agency-application/reopen',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Delete a REJECTED agency application so the user can apply again. KYC contact and government ID are kept.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const result = await agencyKycService.reopenRejectedApplication(request.params.userId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_APPLICATION_REOPENED',
        targetUserId: request.params.userId,
        actionDetails: {
          userId: request.params.userId,
          previousApplicationId: result.previousApplicationId,
        },
      })
      return reply.send(result)
    },
  )

  app.put<{ Params: { userId: string } }>(
    '/users/:userId/tags',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Replace platform-admin tags for a user (max 20, each max 50 chars). Visible on GET /users/me and GET /users/search.',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', minLength: 1 } },
        },
        body: {
          type: 'object',
          required: ['tags'],
          properties: {
            tags: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 50 },
              maxItems: 20,
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminUserTagsBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }

      const result = await adminUserTagsService.setTags(request.params.userId, parsed.data.tags)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_USER_TAGS_UPDATED',
        targetUserId: request.params.userId,
        actionDetails: { tags: parsed.data.tags },
      })
      return reply.send(result)
    },
  )
}
