import type { AgencyAgentApplicationStatus } from '@prisma/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  addHostBodySchema,
  agencyAdminListQuerySchema,
  approveApplicationBodySchema,
  banAgencyBodySchema,
  editCommissionTierBodySchema,
  pendingApplicationsQuerySchema,
  rejectApplicationBodySchema,
  sendAgencyMessageBodySchema,
  setAgencyPayrollBodySchema,
  suspendAgencyBodySchema,
  transferHostsBodySchema,
  adminKycContactPatchSchema,
  adminGovtIdConfirmSchema,
  adminGovtIdUploadUrlSchema,
} from '../../models/agency-admin.schemas'
import { agencyAgentApplicationRepository } from '../../repositories/agencyAgentApplication.repository'
import { agencyAgentApplicationService } from '../../services/agencyAgentApplication.service'
import { agencyAdminService } from '../../services/agencyAdmin.service'
import { adminMessagingService } from '../../services/adminMessaging.service'
import { adminWalletService } from '../../services/adminWallet.service'
import { agencyService } from '../../services/agency.service'
import { agencyHostService } from '../../services/agencyHost.service'
import { agencyCommissionService } from '../../services/agencyCommission.service'
import { agencyKycService } from '../../services/agencyKyc.service'
import { coinTradingService } from '../../services/coinTrading.service'
import { payrollAdminService } from '../../services/payrollAdmin.service'
import { SLOW_REPORT_TIMEOUT_MS } from '../../utils/requestTimeout'
import { agencyCommissionConfigService } from '../../services/agencyCommissionConfig.service'
import { systemRatesAdminService } from '../../services/systemRatesAdmin.service'
import { withdrawalService } from '../../services/withdrawal.service'
import { withdrawalPayoutRailConfigService } from '../../services/withdrawalPayoutRailConfig.service'
import { PayoutRailConfigUpdateSchema } from '../../models/withdrawalPayoutRail.schemas'
import {
  CommissionLevelsReplaceSchema,
  ReplaceRatesSchema,
  ReplaceTradingTopupPackagesSchema,
} from '../../models/system-rates-admin.schemas'
import { addUtcDays, utcNow } from '../../utils/datetime'
import { auditService } from '../../services/audit.service'

const DEFAULT_AGENT_APP_LIST_STATUSES: AgencyAgentApplicationStatus[] = [
  'PENDING',
  'UNDER_REVIEW',
  'MORE_DOCS_REQUIRED',
]

const ApproveSchema = approveApplicationBodySchema

const listAgentApplicationsQuerySchema = z.object({
  status: z
    .enum(['PENDING', 'UNDER_REVIEW', 'MORE_DOCS_REQUIRED', 'APPROVED', 'REJECTED'])
    .optional(),
  forReview: z.coerce.boolean().optional(),
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(20),
})

const preAuth = [authenticateAdmin]

const positiveAmountString = z
  .string()
  .regex(/^\d+$/, 'Must be a non-negative integer string')
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, 'Amount must be positive')

const adminWalletCreditBodySchema = z
  .object({
    coins: positiveAmountString.optional(),
    points: positiveAmountString.optional(),
    tradingCoins: positiveAmountString.optional(),
    description: z.string().min(1).max(500).optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .refine((body) => body.coins != null || body.points != null || body.tradingCoins != null, {
    message: 'At least one of coins, points, or tradingCoins is required',
  })

const agentApplicationStatusPatchSchema = z.object({
  status: z.enum(['UNDER_REVIEW', 'MORE_DOCS_REQUIRED', 'REJECTED']),
  userNote: z.string().max(500).optional(),
  adminNote: z.string().max(500).optional(),
})

const ForceExitSchema = z.object({
  ticketId: z.string().min(1),
  deductPoints: z.string().optional(),
  pauseAgency: z.boolean().optional(),
})

const ReverseSchema = z.object({
  reason: z.string().min(3),
})

const PayrollFeeTierInputSchema = z
  .object({
    minUsd: z.number().nonnegative().optional(),
    maxUsd: z.number().nonnegative().nullable().optional(),
    minPoints: z.string().regex(/^\d+$/).optional(),
    maxPoints: z.string().regex(/^\d+$/).nullable().optional(),
    platformFeeRateBp: z.number().int().min(0).max(10_000),
    agentRewardRateBp: z.number().int().min(0).max(10_000),
  })
  .refine((t) => t.minUsd != null || t.minPoints != null, {
    message: 'Each fee tier requires minUsd or minPoints',
  })

const PayrollCountryFxInputSchema = z.object({
  country: z.string().trim().min(2).max(80),
  countryCode: z.string().trim().min(2).max(3).nullable().optional(),
  currencyCode: z.string().trim().min(3).max(8),
  ratePerUsd: z.number().positive(),
})

const PayrollConfigUpdateSchema = z.object({
  platformFeeRateBp: z.number().int().min(0).optional(),
  agentRewardRateBp: z.number().int().min(0).optional(),
  feeTiers: z.array(PayrollFeeTierInputSchema).min(1).optional(),
  serviceFeeUsd: z.number().optional(),
  minWithdrawalUsd: z.number().optional(),
  maxWithdrawalUsd: z.number().optional(),
  slaHours: z.number().int().positive().optional(),
  waitingHours: z.number().int().positive().optional(),
  maxAssignmentAttempts: z.number().int().positive().optional(),
  inrPerUsd: z.number().optional(),
  nprPerUsd: z.number().optional(),
  countryRates: z.array(PayrollCountryFxInputSchema).min(1).optional(),
})

const AgencyCommissionWindowConfigUpdateSchema = z
  .object({
    windowDays: z.number().int().min(0).max(365).optional(),
    windowHours: z.number().int().min(0).max(23).optional(),
    windowMinutes: z.number().int().min(0).max(59).optional(),
  })
  .refine((b) => b.windowDays != null || b.windowHours != null || b.windowMinutes != null, {
    message: 'Provide at least one of windowDays, windowHours, windowMinutes',
  })

const DisputeResolveSchema = z.object({
  reason: z.string().min(3),
  agencyUserId: z.string().uuid().optional(),
})

const WithdrawalAssignSchema = z.object({
  agencyUserId: z.string().uuid().optional(),
  /** Numeric agency public ID or owner public/display ID. Leading `#` is stripped in the service. */
  agencyPublicId: z.string().trim().regex(/^\d+$/).optional(),
})

const AdminProofUploadUrlSchema = z.object({
  mimeType: z.string().min(1).max(100),
})

const AdminCompletePlatformSchema = z.object({
  proofS3Key: z.string().min(1).max(500),
  proofS3Bucket: z.string().min(1).max(255),
})

const HostTagSchema = z.object({
  isTagged: z.boolean(),
})

export default async function agencyAdminRoutes(app: FastifyInstance) {
  app.get('/stats', { preHandler: preAuth }, async (_request, reply) => {
    const stats = await agencyAdminService.getOverviewStats()
    return reply.send(stats)
  })

  app.get('/', { preHandler: preAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = agencyAdminListQuerySchema.parse(request.query ?? {})
    const result = await agencyAdminService.listAgencies({
      status: q.status,
      country: q.country,
      search: q.q,
      skip: q.skip,
      take: q.take,
    })
    return reply.send(result)
  })

  app.get('/applications/pending', { preHandler: preAuth }, async (request, reply) => {
    const q = pendingApplicationsQuerySchema.parse(request.query ?? {})
    const result = await agencyAdminService.listPendingApplications({
      skip: q.skip,
      take: q.take,
    })
    return reply.send(result)
  })

  app.get('/applications/rejected', { preHandler: preAuth }, async (request, reply) => {
    const q = pendingApplicationsQuerySchema.parse(request.query ?? {})
    const result = await agencyAdminService.listRejectedApplications({
      skip: q.skip,
      take: q.take,
    })
    return reply.send(result)
  })

  app.patch<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/commission-tier',
    { preHandler: preAuth },
    async (request, reply) => {
      const body = editCommissionTierBodySchema.parse(request.body ?? {})
      const agency = await agencyAdminService.resolveAgencyByIdentifier(
        request.params.agencyIdentifier,
      )
      const result = await agencyService.setCommissionTier(agency.userId, body.commissionTier)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_COMMISSION_TIER_SET',
        targetUserId: agency.userId,
        actionDetails: { agencyUserId: agency.userId, commissionTier: body.commissionTier },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/message',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = sendAgencyMessageBodySchema.parse(request.body ?? {})
      const agency = await agencyAdminService.resolveAgencyByIdentifier(
        request.params.agencyIdentifier,
      )
      const result = await adminMessagingService.sendSystemMessage({
        targetUserId: agency.userId,
        adminUserId,
        message: body.message,
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/hosts',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = addHostBodySchema.parse(request.body ?? {})
      const agency = await agencyAdminService.resolveAgencyByIdentifier(
        request.params.agencyIdentifier,
      )
      const hostUserId = await agencyAdminService.resolveUserIdByIdentifier(body.hostUserId)
      const result = await agencyHostService.adminAddHost(agency.userId, hostUserId, adminUserId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_HOST_ADDED',
        targetUserId: hostUserId,
        actionDetails: {
          agencyUserId: agency.userId,
          hostUserId,
          hostIdentifier: body.hostUserId,
        },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/transfer-hosts',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = transferHostsBodySchema.parse(request.body ?? {})
      const source = await agencyAdminService.resolveAgencyByIdentifier(
        request.params.agencyIdentifier,
      )
      const target = await agencyAdminService.resolveAgencyByIdentifier(body.targetAgencyIdentifier)
      const hostUserIds = await Promise.all(
        body.hostUserIds.map((id) => agencyAdminService.resolveUserIdByIdentifier(id)),
      )
      const result = await agencyHostService.adminTransferHosts({
        sourceAgencyUserId: source.userId,
        targetAgencyUserId: target.userId,
        hostUserIds,
        adminUserId,
      })
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_HOSTS_TRANSFERRED',
        targetUserId: target.userId,
        actionDetails: {
          sourceAgencyUserId: source.userId,
          agencyUserId: target.userId,
          hostUserIds,
          hostIdentifiers: body.hostUserIds,
          transferredCount: result.transferredCount,
        },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/suspend',
    { preHandler: preAuth },
    async (request, reply) => {
      const body = suspendAgencyBodySchema.parse(request.body ?? {})
      const agency = await agencyAdminService.resolveAgencyByIdentifier(
        request.params.agencyIdentifier,
      )
      const pausedUntil = body.pausedUntil
        ? new Date(body.pausedUntil)
        : addUtcDays(utcNow(), body.suspendDays!)
      const result = await agencyService.suspendAgencyUntil(agency.userId, pausedUntil, {
        adminUserId: request.adminUser?.id,
      })
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_SUSPENDED',
        targetUserId: agency.userId,
        actionDetails: { agencyUserId: agency.userId, pausedUntil: result.pausedUntil },
      })
      return reply.send(result)
    },
  )

  app.patch<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/payroll',
    { preHandler: preAuth },
    async (request, reply) => {
      const body = setAgencyPayrollBodySchema.parse(request.body ?? {})
      const agency = await agencyAdminService.resolveAgencyByIdentifier(
        request.params.agencyIdentifier,
      )
      const updated = await agencyService.setPayrollPrivilegeGranted(
        agency.userId,
        body.payrollEnabled,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_PAYROLL_PRIVILEGE_SET',
        targetUserId: agency.userId,
        actionDetails: {
          agencyUserId: agency.userId,
          payrollPrivilegeGranted: updated.payrollPrivilegeGranted,
        },
      })
      return reply.send({
        ok: true as const,
        agencyUserId: updated.userId,
        /** Admin privilege grant (agent cannot enable accept without this). */
        payrollPrivilegeGranted: updated.payrollPrivilegeGranted,
        /** Agent accept-toggle; forced false when privilege is revoked. */
        payrollEnabled: updated.payrollEnabled,
      })
    },
  )

  app.post<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/ban',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = banAgencyBodySchema.parse(request.body ?? {})
      const agency = await agencyAdminService.resolveAgencyByIdentifier(
        request.params.agencyIdentifier,
      )
      const result = await agencyAdminService.banAgencyByAdmin(
        agency.userId,
        adminUserId,
        body.reason,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_BANNED',
        targetUserId: agency.userId,
        actionDetails: { agencyUserId: agency.userId, reason: body.reason ?? null },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/barred/:userId/unbar',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await agencyAdminService.unbarUser(request.params.userId, adminUserId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_UNBARRED',
        targetUserId: request.params.userId,
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/applications/:userId/reject',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = rejectApplicationBodySchema.parse(request.body ?? {})
      const result = await agencyAdminService.rejectApplication({
        applicantUserId: request.params.userId,
        adminUserId,
        adminNote: body.adminNote,
        userNote: body.userNote,
      })
      if (!result.alreadyRejected) {
        auditService.logAdminFromRequest(request, {
          actionType: 'ADMIN_AGENCY_REJECTED',
          targetUserId: request.params.userId,
          actionDetails: { adminNote: body.adminNote ?? null },
        })
      }
      return reply.send(result)
    },
  )

  app.get(
    '/applications',
    { preHandler: [authenticateAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = listAgentApplicationsQuerySchema.parse(request.query ?? {})
      const forReview = q.forReview ?? true
      const statuses = q.status
        ? ([q.status] as AgencyAgentApplicationStatus[])
        : forReview
          ? DEFAULT_AGENT_APP_LIST_STATUSES
          : undefined
      const result = await agencyAgentApplicationService.listForAdminReview({
        statuses,
        skip: q.skip,
        take: q.take,
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/credit',
    { preHandler: [authenticateAdmin] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = adminWalletCreditBodySchema.parse(request.body ?? {})
      const result = await adminWalletService.creditUserWallets({
        adminUserId,
        targetUserId: request.params.userId,
        coins: body.coins,
        points: body.points,
        tradingCoins: body.tradingCoins,
        description: body.description,
        idempotencyKey: body.idempotencyKey,
      })
      return reply.send(result)
    },
  )

  app.patch<{ Params: { applicationId: string } }>(
    '/applications/:applicationId/status',
    { preHandler: [authenticateAdmin] },
    async (request: FastifyRequest<{ Params: { applicationId: string } }>, reply: FastifyReply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = agentApplicationStatusPatchSchema.parse(request.body ?? {})
      const application = await agencyAgentApplicationRepository.findById(
        request.params.applicationId,
      )
      if (!application) {
        throw new AppError(404, 'Application not found', 'APPLICATION_NOT_FOUND')
      }
      const previousStatus = application.status
      await agencyAgentApplicationRepository.updateStatus(request.params.applicationId, {
        status: body.status,
        reviewedBy: adminUserId,
        userNote: body.userNote,
        adminNote: body.adminNote,
      })
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_APPLICATION_STATUS_CHANGED',
        targetUserId: application.userId,
        actionDetails: {
          applicationId: request.params.applicationId,
          previousStatus,
          status: body.status,
        },
      })
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/:userId/approve',
    { preHandler: [authenticateAdmin] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = ApproveSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const result = await agencyService.createAgencyFromApplication({
        adminUserId,
        applicantUserId: request.params.userId,
        applicationId: parsed.data.applicationId,
        commissionTier: parsed.data.commissionTier,
      })
      if (result.created) {
        auditService.logAdminFromRequest(request, {
          actionType: 'ADMIN_AGENCY_APPROVED',
          targetUserId: request.params.userId,
          actionDetails: {
            agencyUserId: result.agency.userId,
            applicationId: parsed.data.applicationId,
            commissionTier: parsed.data.commissionTier ?? null,
          },
        })
      }
      return reply.status(result.created ? 201 : 200).send({
        ok: true,
        created: result.created,
        agencyPublicId: result.agency.defaultPublicId.toString(),
      })
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/:userId/unpause',
    { preHandler: [authenticateAdmin] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      await agencyService.unpauseAgency(request.params.userId, {
        adminUserId: request.adminUser?.id,
      })
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_UNPAUSED',
        targetUserId: request.params.userId,
        actionDetails: { agencyUserId: request.params.userId },
      })
      return reply.send({ ok: true })
    },
  )

  app.patch<{ Params: { hostUserId: string } }>(
    '/host/:hostUserId/tag',
    { preHandler: [authenticateAdmin] },
    async (request: FastifyRequest<{ Params: { hostUserId: string } }>, reply: FastifyReply) => {
      const parsed = HostTagSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const result = await agencyHostService.setHostTaggedByAdmin(
        request.params.hostUserId,
        parsed.data.isTagged,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_HOST_TAG_SET',
        targetUserId: request.params.hostUserId,
        actionDetails: {
          agencyUserId: result.agencyUserId,
          hostUserId: request.params.hostUserId,
          isTagged: parsed.data.isTagged,
        },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { hostUserId: string } }>(
    '/cs/host/:hostUserId/force-exit',
    { preHandler: [authenticateAdmin] },
    async (request: FastifyRequest<{ Params: { hostUserId: string } }>, reply: FastifyReply) => {
      const csUserId = request.adminUser?.id
      if (!csUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = ForceExitSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      let ticketId: bigint
      try {
        ticketId = BigInt(parsed.data.ticketId)
      } catch {
        throw new AppError(400, 'Invalid ticket id', 'INVALID_REQUEST')
      }
      let deductPoints: bigint | undefined
      if (parsed.data.deductPoints != null && parsed.data.deductPoints !== '') {
        try {
          deductPoints = BigInt(parsed.data.deductPoints)
        } catch {
          throw new AppError(400, 'Invalid deductPoints', 'INVALID_REQUEST')
        }
      }
      const result = await agencyHostService.forceExitFromCS({
        hostUserId: request.params.hostUserId,
        ticketId,
        deductPoints,
        pauseAgency: parsed.data.pauseAgency,
        csUserId,
      })
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_HOST_FORCE_EXIT',
        targetUserId: request.params.hostUserId,
        actionDetails: {
          agencyUserId: result.agencyUserId,
          hostUserId: result.hostUserId,
          ticketId: parsed.data.ticketId,
          deductPoints: parsed.data.deductPoints ?? null,
          pauseAgency: parsed.data.pauseAgency ?? false,
        },
      })
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { agencyUserId: string } }>(
    '/recompute/:agencyUserId',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Agency'],
        description:
          'Force recompute agency commission tier from the configured rolling window (exact duration from now). Window total sources are env-gated: AGENCY_TIER_INCLUDE_HOST_EARNINGS (default on; unreversed gift/video-call host POINT credits in [now − duration, now)) and/or AGENCY_TIER_INCLUDE_AGENCY_COMMISSION (default off; unreversed AGENT_COMMISSION ledger credits). Also accepts agency publicId via /:identifier routes below.',
      },
    },
    async (request: FastifyRequest<{ Params: { agencyUserId: string } }>, reply: FastifyReply) => {
      const result = await agencyAdminService.forceRecomputeLevel(request.params.agencyUserId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_TIER_RECOMPUTED',
        targetUserId: result.agencyUserId,
        actionDetails: {
          agencyUserId: result.agencyUserId,
          agencyPublicId: result.agencyPublicId,
          beforeLevel: result.before.currentLevel,
          afterLevel: result.after.currentLevel,
          beforeWindowTotalPoints: result.before.currentWindowTotalPoints,
          afterWindowTotalPoints: result.after.currentWindowTotalPoints,
        },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { identifier: string } }>(
    '/:identifier/recompute-level',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Agency'],
        description:
          'Force recompute agency tier (UUID or agency publicId). Metric sources gated by AGENCY_TIER_INCLUDE_HOST_EARNINGS / AGENCY_TIER_INCLUDE_AGENCY_COMMISSION (same as live + nightly recompute).',
      },
    },
    async (request, reply) => {
      const result = await agencyAdminService.forceRecomputeLevel(request.params.identifier)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_TIER_RECOMPUTED',
        targetUserId: result.agencyUserId,
        actionDetails: {
          agencyUserId: result.agencyUserId,
          agencyPublicId: result.agencyPublicId,
          identifier: request.params.identifier,
          beforeLevel: result.before.currentLevel,
          afterLevel: result.after.currentLevel,
          beforeWindowTotalPoints: result.before.currentWindowTotalPoints,
          afterWindowTotalPoints: result.after.currentWindowTotalPoints,
        },
      })
      return reply.send(result)
    },
  )

  app.get<{ Params: { identifier: string } }>(
    '/:identifier/hosts/earnings',
    {
      preHandler: [authenticateAdmin],
      config: { timeoutMs: SLOW_REPORT_TIMEOUT_MS },
      schema: {
        tags: ['Admin', 'Agency'],
        description:
          'List all current hosts for an agency with host earnings + agency commission for a period (default rolling 30 UTC days ending today).',
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, string | undefined>
      const periodParams =
        q.from && q.to
          ? { from: q.from, to: q.to }
          : {
              periodDays: Math.min(
                365,
                Math.max(1, Number(q.periodDays ?? q.period ?? '30') || 30),
              ),
            }
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? '20') || 20))
      return reply.send(
        await agencyAdminService.listHostEarnings(request.params.identifier, periodParams, {
          limit,
          cursor: q.cursor ?? null,
        }),
      )
    },
  )

  app.get<{ Params: { identifier: string } }>(
    '/:identifier/commission/history',
    {
      preHandler: [authenticateAdmin],
      config: { timeoutMs: SLOW_REPORT_TIMEOUT_MS },
      schema: {
        tags: ['Admin', 'Agency'],
        description:
          'List AGENT_COMMISSION ledger credits for an agency (newest first). Filter by hostPublicId / hostUserId and period (default rolling 30 UTC days ending today).',
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, string | undefined>
      const periodParams =
        q.from && q.to
          ? { from: q.from, to: q.to }
          : {
              periodDays: Math.min(
                365,
                Math.max(1, Number(q.periodDays ?? q.period ?? '30') || 30),
              ),
            }
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? '20') || 20))
      return reply.send(
        await agencyAdminService.listCommissionHistory(request.params.identifier, periodParams, {
          hostPublicId: q.hostPublicId?.trim() || undefined,
          hostUserId: q.hostUserId?.trim() || undefined,
          limit,
          cursor: q.cursor ?? null,
        }),
      )
    },
  )

  app.post(
    '/recompute-master',
    { preHandler: [authenticateAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as Record<string, string | undefined>
      const utcDate = q.utcDate?.trim() || undefined
      await agencyCommissionService.enqueueDailyRecomputeMaster({
        utcDate,
        force: true,
      })
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_TIER_RECOMPUTE_MASTER',
        actionDetails: { utcDate: utcDate ?? null, force: true },
      })
      return reply.send({ ok: true, enqueued: true })
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/applications/:userId/kyc',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const status = await agencyKycService.getKycStatusForAdmin(request.params.userId)
      return reply.send(status)
    },
  )

  app.patch<{ Params: { userId: string } }>(
    '/applications/:userId/kyc',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Agency'],
        description:
          'Update KYC-linked phone and/or email for a pending applicant (or any user with a KYC row). Does not change login auth identifiers.',
      },
    },
    async (request, reply) => {
      const body = adminKycContactPatchSchema.parse(request.body ?? {})
      const result = await agencyKycService.updateAdminKycContact(request.params.userId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_KYC_CONTACT_UPDATED',
        targetUserId: request.params.userId,
        actionDetails: {
          userId: request.params.userId,
          fields: Object.keys(body),
        },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/applications/:userId/kyc/govt-id/upload-url',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Agency'],
        description:
          'Presign S3 PUT for replacing an applicant government ID. Allowed even if the application is approved or rejected.',
      },
    },
    async (request, reply) => {
      const body = adminGovtIdUploadUrlSchema.parse(request.body ?? {})
      const data = await agencyKycService.getPresignedGovtIdUrl(
        request.params.userId,
        body.mimeType,
        { admin: true },
      )
      return reply.send(data)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/applications/:userId/kyc/govt-id/confirm',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Agency'],
        description: 'Confirm applicant government ID upload after PUT to the presigned URL.',
      },
    },
    async (request, reply) => {
      const body = adminGovtIdConfirmSchema.parse(request.body ?? {})
      const result = await agencyKycService.confirmAdminGovtIdUpload(
        request.params.userId,
        body.s3Key,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_KYC_GOVT_ID_UPDATED',
        targetUserId: request.params.userId,
        actionDetails: { userId: request.params.userId, s3Key: body.s3Key },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/applications/:userId/reopen',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Agency'],
        description:
          'Delete a REJECTED application so the user can apply again. KYC contact and government ID are kept.',
      },
    },
    async (request, reply) => {
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

  app.patch<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/kyc-contact',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Agency'],
        description:
          'Update KYC-linked phone and/or email on an approved agency. Does not change login auth identifiers.',
      },
    },
    async (request, reply) => {
      const body = adminKycContactPatchSchema.parse(request.body ?? {})
      const result = await agencyAdminService.updateKycContact(request.params.agencyIdentifier, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_KYC_CONTACT_UPDATED',
        targetUserId: result.userId,
        actionDetails: {
          agencyIdentifier: request.params.agencyIdentifier,
          userId: result.userId,
          fields: Object.keys(body),
        },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/kyc/govt-id/upload-url',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Agency'],
        description:
          'Presign S3 PUT for replacing an approved agency owner government ID.',
      },
    },
    async (request, reply) => {
      const body = adminGovtIdUploadUrlSchema.parse(request.body ?? {})
      const data = await agencyAdminService.getGovtIdUploadUrl(
        request.params.agencyIdentifier,
        body.mimeType,
      )
      return reply.send(data)
    },
  )

  app.post<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier/kyc/govt-id/confirm',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Agency'],
        description: 'Confirm agency owner government ID upload after PUT to the presigned URL.',
      },
    },
    async (request, reply) => {
      const body = adminGovtIdConfirmSchema.parse(request.body ?? {})
      const result = await agencyAdminService.confirmGovtIdUpload(
        request.params.agencyIdentifier,
        body.s3Key,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_KYC_GOVT_ID_UPDATED',
        targetUserId: result.userId,
        actionDetails: {
          agencyIdentifier: request.params.agencyIdentifier,
          userId: result.userId,
          s3Key: body.s3Key,
        },
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { transferId: string } }>(
    '/coin-trading/reverse/:transferId',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const parsed = ReverseSchema.parse(request.body ?? {})
      const adminUserId = request.adminUser!.id
      await coinTradingService.reverseTransfer(
        adminUserId,
        request.params.transferId,
        parsed.reason,
      )
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/coin-trading/unlock/:userId',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      await agencyService.unpauseAgency(request.params.userId, {
        adminUserId: request.adminUser?.id,
      })
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_UNPAUSED',
        targetUserId: request.params.userId,
        actionDetails: { agencyUserId: request.params.userId, source: 'coin-trading-unlock' },
      })
      return reply.send({ ok: true })
    },
  )

  app.get(
    '/coin-trading/topup-rates',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await systemRatesAdminService.getTopupRates())
    },
  )

  app.put(
    '/coin-trading/topup-rates',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const body = ReplaceRatesSchema.parse(request.body ?? {})
      const result = await systemRatesAdminService.replaceTopupRates(body.tiers)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'coin-trading-topup-rates' },
      })
      return reply.send(result)
    },
  )

  app.get(
    '/coin-trading/exchange-rates',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await systemRatesAdminService.getAgentExchangeRates())
    },
  )

  app.put(
    '/coin-trading/exchange-rates',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const body = ReplaceRatesSchema.parse(request.body ?? {})
      const result = await systemRatesAdminService.replaceAgentExchangeRates(body.tiers)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'coin-trading-exchange-rates' },
      })
      return reply.send(result)
    },
  )

  app.get(
    '/coin-trading/topup-packages',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await systemRatesAdminService.getTradingTopupPackages())
    },
  )

  app.put(
    '/coin-trading/topup-packages',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const body = ReplaceTradingTopupPackagesSchema.parse(request.body ?? {})
      const result = await systemRatesAdminService.replaceTradingTopupPackages(body.packages)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'coin-trading-topup-packages' },
      })
      return reply.send(result)
    },
  )

  app.get('/payroll/config', { preHandler: [authenticateAdmin] }, async (_request, reply) => {
    const cfg = await payrollAdminService.getConfig()
    return reply.send(cfg)
  })

  app.put('/payroll/config', { preHandler: [authenticateAdmin] }, async (request, reply) => {
    const adminUserId = request.adminUser?.id
    if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const body = PayrollConfigUpdateSchema.parse(request.body ?? {})
    const cfg = await payrollAdminService.updateConfig(adminUserId, body)
    auditService.logAdminFromRequest(request, {
      actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
      actionDetails: { settingKey: 'payroll-config' },
    })
    return reply.send(cfg)
  })

  app.get('/commission/config', { preHandler: [authenticateAdmin] }, async (_request, reply) => {
    const cfg = await agencyCommissionConfigService.getConfig()
    return reply.send(cfg)
  })

  app.put('/commission/config', { preHandler: [authenticateAdmin] }, async (request, reply) => {
    const adminUserId = request.adminUser?.id
    if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const body = AgencyCommissionWindowConfigUpdateSchema.parse(request.body ?? {})
    const cfg = await agencyCommissionConfigService.updateConfig(adminUserId, body)
    await agencyCommissionService.enqueueDailyRecomputeMaster({ force: true })
    auditService.logAdminFromRequest(request, {
      actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
      actionDetails: { settingKey: 'commission-config' },
    })
    return reply.send({ ...cfg, recomputeEnqueued: true })
  })

  app.get('/commission/levels', { preHandler: [authenticateAdmin] }, async (_request, reply) => {
    return reply.send(await systemRatesAdminService.getCommissionLevels())
  })

  app.put('/commission/levels', { preHandler: [authenticateAdmin] }, async (request, reply) => {
    const body = CommissionLevelsReplaceSchema.parse(request.body ?? {})
    const result = await systemRatesAdminService.replaceCommissionLevels(body.levels)
    auditService.logAdminFromRequest(request, {
      actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
      actionDetails: { settingKey: 'commission-levels' },
    })
    return reply.send(result)
  })

  app.get(
    '/withdrawal/payout-rails',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      const config = await withdrawalPayoutRailConfigService.getPublicConfig()
      return reply.send(config)
    },
  )

  app.put(
    '/withdrawal/payout-rails',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = PayoutRailConfigUpdateSchema.parse(request.body ?? {})
      const config = await withdrawalPayoutRailConfigService.updateConfig(adminUserId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'withdrawal-payout-rails' },
      })
      return reply.send(config)
    },
  )

  app.get('/payroll/disputed', { preHandler: [authenticateAdmin] }, async (request, reply) => {
    const q = request.query as { limit?: string; cursor?: string }
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? '20') || 20))
    const result = await payrollAdminService.getDisputedPayrolls({
      limit,
      cursor: q.cursor,
    })
    return reply.send(result)
  })

  app.get('/payroll/assignments', { preHandler: preAuth }, async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? '20') || 20))
    const status = q.status?.trim()
    if (status && !['PENDING', 'WAITING', 'COMPLETED', 'REJECTED', 'EXPIRED'].includes(status)) {
      throw new AppError(400, 'Invalid status', 'INVALID_REQUEST')
    }
    const result = await payrollAdminService.listAssignments({
      status,
      agencyUserId: q.agencyUserId?.trim() || undefined,
      agencyPublicId: q.agencyPublicId?.trim() || undefined,
      hostUserId: q.hostUserId?.trim() || undefined,
      hostPublicId: q.hostPublicId?.trim() || undefined,
      withdrawalId: q.withdrawalId?.trim() || undefined,
      from: q.from?.trim() || undefined,
      to: q.to?.trim() || undefined,
      cursor: q.cursor?.trim() || undefined,
      limit,
    })
    return reply.send(result)
  })

  app.get<{ Params: { assignmentId: string } }>(
    '/payroll/assignments/:assignmentId',
    { preHandler: preAuth },
    async (request, reply) => {
      return reply.send(await payrollAdminService.getAssignmentDetail(request.params.assignmentId))
    },
  )

  app.get(
    '/payroll/pending-platform',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const q = request.query as { limit?: string; cursor?: string; handler?: string }
      const limit = Math.min(50, Math.max(1, Number(q.limit ?? '20') || 20))
      const handler = q.handler === 'PLATFORM' || q.handler === 'AGENCY' ? q.handler : undefined
      const result = await payrollAdminService.listPendingPlatformWithdrawals({
        limit,
        cursor: q.cursor,
        payoutHandler: handler,
      })
      return reply.send(result)
    },
  )

  app.get<{ Params: { id: string } }>(
    '/withdrawal/:id',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      return reply.send(await payrollAdminService.getWithdrawalDetail(request.params.id))
    },
  )

  app.post<{ Params: { id: string } }>(
    '/withdrawal/:id/reverse',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = ReverseSchema.parse(request.body ?? {})
      const row = await withdrawalService.adminReverseWithdrawal(
        adminUserId,
        request.params.id,
        parsed.reason,
      )
      return reply.send(withdrawalService.serializeWithdrawal(row))
    },
  )

  app.post<{ Params: { id: string } }>(
    '/withdrawal/:id/assign',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = WithdrawalAssignSchema.parse(request.body ?? {})
      await payrollAdminService.manuallyAssignWithdrawal(adminUserId, request.params.id, {
        agencyUserId: body.agencyUserId,
        agencyPublicId: body.agencyPublicId,
      })
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/withdrawal/:id/proof-upload-url',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = AdminProofUploadUrlSchema.parse(request.body ?? {})
      const result = await withdrawalService.getAdminPresignedProofUrl(
        request.params.id,
        body.mimeType,
      )
      return reply.send(result)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/withdrawal/:id/complete',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = AdminCompletePlatformSchema.parse(request.body ?? {})
      const result = await withdrawalService.adminCompletePlatformPayout(
        adminUserId,
        request.params.id,
        body,
      )
      return reply.send({ ok: true, ...result })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/withdrawal/:id/takeover',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = AdminCompletePlatformSchema.parse(request.body ?? {})
      const result = await withdrawalService.adminCompletePayrollTakeover(
        adminUserId,
        request.params.id,
        body,
      )
      return reply.send({ ok: true, ...result })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/withdrawal/:id/resolve-dispute/favour-agent',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = DisputeResolveSchema.parse(request.body ?? {})
      await withdrawalService.adminResolveDisputeFavourAgent(
        adminUserId,
        request.params.id,
        body.reason,
      )
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/withdrawal/:id/resolve-dispute/favour-host',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = DisputeResolveSchema.parse(request.body ?? {})
      await withdrawalService.adminResolveDisputeFavourHost(
        adminUserId,
        request.params.id,
        body.reason,
        body.agencyUserId,
      )
      return reply.send({ ok: true })
    },
  )

  app.get<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier',
    { preHandler: preAuth },
    async (request, reply) => {
      const detail = await agencyAdminService.getAgencyDetail(request.params.agencyIdentifier)
      return reply.send(detail)
    },
  )

  app.delete<{ Params: { agencyIdentifier: string } }>(
    '/:agencyIdentifier',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const agency = await agencyAdminService.resolveAgencyByIdentifier(
        request.params.agencyIdentifier,
      )
      const result = await agencyAdminService.deleteAgencyByAdmin(agency.userId, adminUserId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_AGENCY_DELETED',
        targetUserId: agency.userId,
        actionDetails: { agencyUserId: agency.userId },
      })
      return reply.send(result)
    },
  )
}
