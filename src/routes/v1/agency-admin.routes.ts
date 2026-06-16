import type { AgencyAgentApplicationStatus } from '@prisma/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAdmin } from '../../middlewares/requireAdmin'
import { AppError } from '../../middlewares/errorHandler'
import { agencyAgentApplicationRepository } from '../../repositories/agencyAgentApplication.repository'
import { agencyAgentApplicationService } from '../../services/agencyAgentApplication.service'
import { adminWalletService } from '../../services/adminWallet.service'
import { agencyService } from '../../services/agency.service'
import { agencyHostService } from '../../services/agencyHost.service'
import { agencyCommissionService } from '../../services/agencyCommission.service'
import { agencyKycService } from '../../services/agencyKyc.service'
import { coinTradingService } from '../../services/coinTrading.service'
import { payrollAdminService } from '../../services/payrollAdmin.service'
import { withdrawalService } from '../../services/withdrawal.service'
import { withdrawalPayoutRailConfigService } from '../../services/withdrawalPayoutRailConfig.service'
import { redisClient, RedisKeys } from '../../config/redis'
import { prisma } from '../../config/database'
import { PayoutRailConfigUpdateSchema } from '../../models/withdrawalPayoutRail.schemas'

const DEFAULT_AGENT_APP_LIST_STATUSES: AgencyAgentApplicationStatus[] = [
  'PENDING',
  'UNDER_REVIEW',
  'MORE_DOCS_REQUIRED',
]

const ApproveSchema = z.object({
  applicationId: z.string().uuid(),
})

const listAgentApplicationsQuerySchema = z.object({
  status: z
    .enum(['PENDING', 'UNDER_REVIEW', 'MORE_DOCS_REQUIRED', 'APPROVED', 'REJECTED'])
    .optional(),
  /** When true (default), returns open review queue only. When false with no `status`, returns all. */
  forReview: z.coerce.boolean().optional(),
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(20),
})

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
  .refine(
    (body) => body.coins != null || body.points != null || body.tradingCoins != null,
    { message: 'At least one of coins, points, or tradingCoins is required' },
  )

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

const ReplaceRatesSchema = z.object({
  tiers: z.array(
    z.object({
      minUsd: z.number().nonnegative(),
      maxUsd: z.number().nullable().optional(),
      coinsPerUsd: z.number().int().positive(),
    }),
  ),
})

const PayrollConfigUpdateSchema = z.object({
  platformFeeRateBp: z.number().int().min(0).optional(),
  agentRewardRateBp: z.number().int().min(0).optional(),
  serviceFeeUsd: z.number().optional(),
  minWithdrawalUsd: z.number().optional(),
  maxWithdrawalUsd: z.number().optional(),
  slaHours: z.number().int().positive().optional(),
  waitingHours: z.number().int().positive().optional(),
  maxAssignmentAttempts: z.number().int().positive().optional(),
  inrPerUsd: z.number().optional(),
})

const DisputeResolveSchema = z.object({
  reason: z.string().min(3),
  agencyUserId: z.string().uuid().optional(),
})

const WithdrawalAssignSchema = z.object({
  agencyUserId: z.string().uuid().optional(),
})

const HostTagSchema = z.object({
  isTagged: z.boolean(),
})

export default async function agencyAdminRoutes(app: FastifyInstance) {
  app.get(
    '/applications',
    { preHandler: [requireAdmin] },
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
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const adminUserId = request.userId
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
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest<{ Params: { applicationId: string } }>, reply: FastifyReply) => {
      const adminUserId = request.userId
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = agentApplicationStatusPatchSchema.parse(request.body ?? {})
      await agencyAgentApplicationRepository.updateStatus(request.params.applicationId, {
        status: body.status,
        reviewedBy: adminUserId,
        userNote: body.userNote,
        adminNote: body.adminNote,
      })
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/:userId/approve',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const adminUserId = request.userId
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
      })
      return reply.status(result.created ? 201 : 200).send({
        ok: true,
        created: result.created,
        agencyPublicId: result.agency.defaultPublicId.toString(),
      })
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/:userId/unpause',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      await agencyService.unpauseAgency(request.params.userId)
      return reply.send({ ok: true })
    },
  )

  app.patch<{ Params: { hostUserId: string } }>(
    '/host/:hostUserId/tag',
    { preHandler: [requireAdmin] },
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
      return reply.send(result)
    },
  )

  app.post<{ Params: { hostUserId: string } }>(
    '/cs/host/:hostUserId/force-exit',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest<{ Params: { hostUserId: string } }>, reply: FastifyReply) => {
      const csUserId = request.userId
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
      await agencyHostService.forceExitFromCS({
        hostUserId: request.params.hostUserId,
        ticketId,
        deductPoints,
        pauseAgency: parsed.data.pauseAgency,
        csUserId,
      })
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { agencyUserId: string } }>(
    '/recompute/:agencyUserId',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest<{ Params: { agencyUserId: string } }>, reply: FastifyReply) => {
      await agencyCommissionService.recomputeAgencyLevel(request.params.agencyUserId, {
        skipDailyDedupe: true,
      })
      return reply.send({ ok: true })
    },
  )

  app.post(
    '/recompute-master',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as Record<string, string | undefined>
      const utcDate = q.utcDate?.trim() || undefined
      await agencyCommissionService.enqueueDailyRecomputeMaster({
        utcDate,
        force: true,
      })
      return reply.send({ ok: true, enqueued: true })
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/applications/:userId/kyc',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const status = await agencyKycService.getKycStatusForAdmin(request.params.userId)
      return reply.send(status)
    },
  )

  app.post<{ Params: { transferId: string } }>(
    '/coin-trading/reverse/:transferId',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const parsed = ReverseSchema.parse(request.body ?? {})
      await coinTradingService.reverseTransfer(
        request.userId!,
        request.params.transferId,
        parsed.reason,
      )
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/coin-trading/unlock/:userId',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      await agencyService.unpauseAgency(request.params.userId)
      return reply.send({ ok: true })
    },
  )

  app.put('/coin-trading/topup-rates', { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = ReplaceRatesSchema.parse(request.body ?? {})
    await prisma.$transaction(async (tx) => {
      await tx.coinTradingTopupRate.updateMany({ data: { isActive: false } })
      for (let i = 0; i < body.tiers.length; i++) {
        const tier = body.tiers[i]!
        await tx.coinTradingTopupRate.create({
          data: {
            minUsd: tier.minUsd,
            maxUsd: tier.maxUsd ?? null,
            coinsPerUsd: tier.coinsPerUsd,
            sortOrder: i + 1,
            isActive: true,
          },
        })
      }
    })
    await redisClient.del(RedisKeys.ctTopupRates())
    return reply.send({ ok: true })
  })

  app.put(
    '/coin-trading/exchange-rates',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const body = ReplaceRatesSchema.parse(request.body ?? {})
      await prisma.$transaction(async (tx) => {
        await tx.agentExchangeRate.updateMany({ data: { isActive: false } })
        for (let i = 0; i < body.tiers.length; i++) {
          const tier = body.tiers[i]!
          await tx.agentExchangeRate.create({
            data: {
              minUsdEquiv: tier.minUsd,
              maxUsdEquiv: tier.maxUsd ?? null,
              coinsPerUsd: tier.coinsPerUsd,
              sortOrder: i + 1,
              isActive: true,
            },
          })
        }
      })
      await redisClient.del(RedisKeys.ctExchangeRates())
      // Exchange packages are derived from these rates (cached per user type).
      await redisClient.del(
        RedisKeys.ctExchangePackages('agent'),
        RedisKeys.ctExchangePackages('personal'),
      )
      return reply.send({ ok: true })
    },
  )

  app.get('/payroll/config', { preHandler: [requireAdmin] }, async (_request, reply) => {
    const cfg = await payrollAdminService.getConfig()
    return reply.send(cfg)
  })

  app.put('/payroll/config', { preHandler: [requireAdmin] }, async (request, reply) => {
    const adminUserId = request.userId
    if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const body = PayrollConfigUpdateSchema.parse(request.body ?? {})
    await payrollAdminService.updateConfig(adminUserId, body)
    return reply.send({ ok: true })
  })

  app.get('/withdrawal/payout-rails', { preHandler: [requireAdmin] }, async (_request, reply) => {
    const config = await withdrawalPayoutRailConfigService.getPublicConfig()
    return reply.send(config)
  })

  app.put('/withdrawal/payout-rails', { preHandler: [requireAdmin] }, async (request, reply) => {
    const adminUserId = request.userId
    if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const body = PayoutRailConfigUpdateSchema.parse(request.body ?? {})
    const config = await withdrawalPayoutRailConfigService.updateConfig(adminUserId, body)
    return reply.send(config)
  })

  app.get('/payroll/disputed', { preHandler: [requireAdmin] }, async (request, reply) => {
    const q = request.query as { limit?: string; cursor?: string }
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? '20') || 20))
    const result = await payrollAdminService.getDisputedPayrolls({
      limit,
      cursor: q.cursor,
    })
    return reply.send(result)
  })

  app.get('/payroll/pending-platform', { preHandler: [requireAdmin] }, async (request, reply) => {
    const q = request.query as { limit?: string; cursor?: string }
    const limit = Math.min(50, Math.max(1, Number(q.limit ?? '20') || 20))
    const result = await payrollAdminService.listPendingPlatformWithdrawals({
      limit,
      cursor: q.cursor,
    })
    return reply.send(result)
  })

  app.post<{ Params: { id: string } }>(
    '/withdrawal/:id/reverse',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const adminUserId = request.userId
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
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const adminUserId = request.userId
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = WithdrawalAssignSchema.parse(request.body ?? {})
      await payrollAdminService.manuallyAssignWithdrawal(
        adminUserId,
        request.params.id,
        body.agencyUserId,
      )
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/withdrawal/:id/resolve-dispute/favour-agent',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const adminUserId = request.userId
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
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const adminUserId = request.userId
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
}
